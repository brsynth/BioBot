"""Daily USD allowance for user requests funded by the installation's API key.

Reserve before contacting OpenAI, settle against reported usage afterwards. A
lost stream/process keeps its reservation until midnight rather than refunding
possibly billed work. Shared maintenance runs without a user allowance.
"""
from contextvars import ContextVar
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import hashlib
import json
import os
import uuid

_actor = ContextVar('api_budget_user', default=None)
DEFAULT_LIMIT = Decimal('0.50')
UNIT = Decimal('0.000001')
# Standard USD rates: https://developers.openai.com/api/docs/models/text-embedding-3-small
EMBEDDING_PRICE = {'input': 0.02, 'output': 0, 'cached_input': 0.02}
SEARCH_FEE = Decimal('0.01')  # https://developers.openai.com/api/docs/pricing


class BudgetError(RuntimeError):
    pass


def set_user(user_id):
    return _actor.set(int(user_id) if user_id else None)


def reset_user(token):
    _actor.reset(token)


def init_usage_table(cursor):
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_api_limit JSONB")
    cursor.execute('''CREATE TABLE IF NOT EXISTS api_usage (
        id UUID PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day DATE NOT NULL, model TEXT NOT NULL, amount NUMERIC(20,8) NOT NULL,
        reserved BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())''')
    cursor.execute('CREATE INDEX IF NOT EXISTS api_usage_user_day ON api_usage(user_id, day)')


def daily_limit(cursor, user):
    cursor.execute('SELECT daily_api_limit FROM users WHERE id=%s', (user,))
    row = cursor.fetchone()
    if row is None:
        raise BudgetError('Your account is no longer available. Please sign in again.')
    setting = row[0]
    return DEFAULT_LIMIT if setting is None else (None if setting['usd'] is None else Decimal(str(setting['usd'])))


def validate_limit(value):
    try:
        amount = None if value is None else Decimal(str(value))
        if amount is not None and (not amount.is_finite() or amount < 0 or amount > 1_000_000
                                   or amount != amount.quantize(UNIT)):
            raise ValueError()
    except (InvalidOperation, ValueError):
        raise ValueError('Enter a daily USD allowance of 0 or more (up to 6 decimal places), or select Unlimited.')
    return float(amount) if amount is not None else None


def _hash(key):
    return hashlib.sha256(key.encode()).hexdigest() if key else ''


def funded_user(key):
    """Personal credentials bypass the installation allowance, including in subprocesses."""
    user = _actor.get()
    if user is None:
        user = os.environ.get('BIOBOT_USAGE_USER')
        expected = os.environ.get('BIOBOT_USAGE_KEY_HASH')
        return int(user) if user and expected and _hash(key) == expected else None
    from config import get_api_key
    return user if key and key == get_api_key(required=False) else None


def subprocess_context(env, key):
    user = funded_user(key)
    for name in ('BIOBOT_USAGE_USER', 'BIOBOT_USAGE_KEY_HASH'):
        env.pop(name, None)
    if user:
        env.update(BIOBOT_USAGE_USER=str(user), BIOBOT_USAGE_KEY_HASH=_hash(key))


def _rates(cursor, model):
    from model_settings import _read, _model_prices
    prices = {item['id']: item for item in (_read(cursor, 'openai_catalog') or {}).get('models', [])}
    rates = _model_prices(model, prices)
    if model == 'text-embedding-3-small':
        rates = EMBEDDING_PRICE
    if any(rates.get(key) is None for key in ('input', 'output')):
        return None
    result = {key: Decimal(str(rates.get(key) if rates.get(key) is not None else rates['input']))
              for key in ('input', 'output', 'cached_input')}
    if any(not value.is_finite() or value < 0 for value in result.values()):
        return None
    return result


def _reserve(user, model, kwargs, embedding):
    from config import get_db_connection
    conn = get_db_connection()
    try:
        with conn, conn.cursor() as cursor:
            # Lock before reading settings and totals; works across web workers and subprocesses.
            cursor.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', (f'api-budget:{user}',))
            limit = daily_limit(cursor, user=user)
            if limit == 0:
                raise BudgetError('The shared daily allowance is disabled. Add your own API key in Settings.')
            rates = _rates(cursor, model)
            if rates is None:
                if limit is None:
                    return None
                raise BudgetError('The shared allowance needs a published price for this model. Ask an administrator to refresh models and prices.')
            # UTF-8 bytes provide a conservative text-token bound, plus request framing.
            text = {key: value for key, value in kwargs.items() if key in ('input', 'instructions', 'tools', 'text')}
            tokens = len(json.dumps(text, ensure_ascii=False).encode()) + 256
            search = any(tool.get('type') == 'web_search' for tool in kwargs.get('tools', []))
            output = 0 if embedding else int(kwargs.get('max_output_tokens') or 16384)
            if search:
                # Bound tool calls; retrieved content remains an estimate until usage is returned.
                kwargs['max_tool_calls'] = 1
                tokens += 16000
            base = Decimal(tokens) * rates['input'] / 1_000_000 + (SEARCH_FEE if search else 0)
            cursor.execute("SELECT COALESCE(SUM(amount), 0) FROM api_usage WHERE user_id=%s AND day=(NOW() AT TIME ZONE 'UTC')::date", (user,))
            spent = cursor.fetchone()[0]
            if limit is not None:
                remaining = limit - spent - base
                if not embedding and rates['output'] > 0:
                    output = min(output, int(remaining * 1_000_000 / rates['output']))
                if remaining < 0 or (not embedding and output < 256):
                    raise BudgetError(f'Your ${limit:.2f} daily shared allowance is used or reserved by another task. It resets at 00:00 UTC. You can also add your own API key in Settings.')
            if not embedding:
                kwargs['max_output_tokens'] = output
                kwargs['service_tier'] = 'default'
            estimate = (base + Decimal(output) * rates['output'] / 1_000_000).quantize(UNIT, rounding=ROUND_CEILING)
            if limit is not None and spent + estimate > limit:
                raise BudgetError('There is not enough shared daily allowance left for this request. It resets at 00:00 UTC.')
            identifier = str(uuid.uuid4())
            cursor.execute("INSERT INTO api_usage(id,user_id,day,model,amount) VALUES(%s,%s,(NOW() AT TIME ZONE 'UTC')::date,%s,%s)",
                           (identifier, user, model, estimate))
            return identifier, rates, user
    finally:
        conn.close()


def _get(value, name, default=None):
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def _settle(reservation, response=None, failed=False):
    if reservation is None:
        return
    identifier, rates, user = reservation
    usage = _get(response, 'usage')
    if not failed and usage is None:
        return  # unknown billing: retain the reservation, including interrupted streams
    amount = Decimal(0)
    if usage is not None:
        inputs = int(_get(usage, 'input_tokens', _get(usage, 'total_tokens', 0)) or 0)
        outputs = int(_get(usage, 'output_tokens', 0) or 0)
        cached = min(inputs, int(_get(_get(usage, 'input_tokens_details'), 'cached_tokens', 0) or 0))
        amount = (Decimal(inputs - cached) * rates['input'] + Decimal(cached) * rates['cached_input']
                  + Decimal(outputs) * rates['output']) / 1_000_000
        searches = sum(_get(item, 'type') == 'web_search_call' for item in (_get(response, 'output', []) or []))
        amount += searches * SEARCH_FEE
    from config import get_db_connection
    conn = get_db_connection()
    try:
        with conn, conn.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', (f'api-budget:{user}',))
            cursor.execute('UPDATE api_usage SET amount=%s,reserved=FALSE WHERE id=%s AND reserved=TRUE', (amount, identifier))
    finally:
        conn.close()


class _Resource:
    def __init__(self, resource, user, embedding=False):
        self._resource, self._user, self._embedding = resource, user, embedding

    def __getattr__(self, name):
        return getattr(self._resource, name)

    def create(self, **kwargs):
        reservation = _reserve(self._user, kwargs['model'], kwargs, self._embedding)
        try:
            result = self._resource.create(**kwargs)
        except Exception as error:
            # An explicit HTTP rejection was not processed; network failures may have been billed.
            if getattr(error, 'status_code', None) in (400, 401, 403, 404, 422, 429):
                _settle(reservation, failed=True)
            raise
        if kwargs.get('stream'):
            return self._stream(result, reservation)
        _settle(reservation, result)
        return result

    @staticmethod
    def _stream(stream, reservation):
        try:
            for event in stream:
                if _get(event, 'type') in ('response.completed', 'response.incomplete', 'response.failed'):
                    _settle(reservation, _get(event, 'response'))
                yield event
        finally:
            stream.close()


class _Client:
    def __init__(self, client, user):
        self._client, self._user = client, user
        self.responses = _Resource(client.responses, user)
        self.embeddings = _Resource(client.embeddings, user, embedding=True)

    def __getattr__(self, name):
        return getattr(self._client, name)

    def with_options(self, **kwargs):
        kwargs["max_retries"] = 0
        return _Client(self._client.with_options(**kwargs), self._user)

    copy = with_options


def metered_openai(factory):
    """Wrap the SDK constructor, keeping ordinary clients for personal keys and maintenance."""
    def create(*args, **kwargs):
        client = factory(*args, **kwargs)
        user = funded_user(kwargs.get('api_key') or getattr(client, 'api_key', None))
        return _Client(client.with_options(max_retries=0), user) if user else client
    return create
