"""Validated account and device maintenance; callers enforce administrator access."""
from equipment_categories import categories_for, clean_categories

import json
import os
import math
import re
from psycopg2.extras import Json, RealDictCursor
from werkzeug.security import generate_password_hash
from config import get_db_connection
from crypt import generate_salt


class Busy(ValueError):
    pass


def audit(cursor, actor, action, target, fields):
    cursor.execute("INSERT INTO admin_audit (actor_id, action, target, changed_fields) VALUES (%s, %s, %s, %s)",
                   (actor, action, str(target), Json(fields)))


def users():
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute("""SELECT u.id,first_name,last_name,email,role,country,admin_status,u.created_at,
                COALESCE(u.daily_api_limit,'{\"usd\":0.5}'::jsonb) AS daily_api_limit,
                COALESCE(usage.amount,0) AS daily_api_spent,COALESCE(credits.amount,0) AS daily_api_credit
                FROM users u
                LEFT JOIN (SELECT user_id,SUM(amount) AS amount FROM api_usage
                           WHERE day=(NOW() AT TIME ZONE 'UTC')::date GROUP BY user_id) usage ON usage.user_id=u.id
                LEFT JOIN (SELECT user_id,SUM(amount) AS amount FROM api_quota_recharges
                           WHERE day=(NOW() AT TIME ZONE 'UTC')::date GROUP BY user_id) credits ON credits.user_id=u.id
                ORDER BY u.id""")
            return [{**dict(row), 'daily_api_limit': row['daily_api_limit']['usd'],
                     'daily_api_spent': float(row['daily_api_spent']), 'daily_api_credit':float(row['daily_api_credit'])} for row in cursor.fetchall()]
    finally:
        conn.close()



def recharge_quota(target, amount, actor):
    from api_budget import validate_limit
    import uuid
    amount = validate_limit(amount)
    if amount is None or amount <= 0:
        raise ValueError('Enter a recharge amount greater than 0 USD.')
    conn = get_db_connection()
    try:
        with conn, conn.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (f'api-budget:{target}',))
            cursor.execute('SELECT id FROM users WHERE id=%s', (target,))
            if not cursor.fetchone():
                raise ValueError('User not found.')
            cursor.execute("""INSERT INTO api_quota_recharges(id,user_id,day,amount,actor_id)
                VALUES(%s,%s,(NOW() AT TIME ZONE 'UTC')::date,%s,%s)""", (str(uuid.uuid4()),target,amount,actor))
            audit(cursor,actor,'recharge_quota',target,['amount_usd',str(amount)])
    finally:
        conn.close()
    return amount


def edit_user(target, data, actor, is_owner):
    allowed = {'first_name', 'last_name', 'email', 'role', 'country', 'admin_status', 'daily_api_limit'}
    if not isinstance(data, dict) or not data or set(data) - allowed:
        raise ValueError('Unsupported user fields.')
    for key, value in data.items():
        if key == 'daily_api_limit':
            from api_budget import validate_limit
            validate_limit(value)
        elif key == 'admin_status':
            if value not in (None, 'requested', 'approved'):
                raise ValueError('Invalid administrator status.')
        elif not isinstance(value, str) or len(value) > 200:
            raise ValueError('User fields must be text of up to 200 characters.')
    if 'email' in data and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', data['email'].strip()):
        raise ValueError('Enter a valid email address.')
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute('SELECT * FROM users WHERE id = %s FOR UPDATE', (target,))
            row = cursor.fetchone()
            if row is None:
                raise ValueError('User not found.')
            if 'email' in data:
                email = data['email'].strip().lower()
                if email.casefold() != (row['email'] or '').casefold() and (is_owner(email) or is_owner(row['email'])):
                    raise ValueError('Server owner addresses are managed in BIOBOT_ADMINS and cannot be reassigned here.')
                cursor.execute('SELECT id FROM users WHERE lower(email) = lower(%s) AND id <> %s', (email, target))
                if cursor.fetchone():
                    raise ValueError('This email address is already in use.')
                data['email'] = email
            if 'admin_status' in data and data['admin_status'] != 'approved' and (target == actor or is_owner(row['email'])):
                raise ValueError('You cannot remove your own administrator access or change a server owner’s access.')
            if 'daily_api_limit' in data:
                from api_budget import validate_limit
                data = {**data, 'daily_api_limit': Json({'usd': validate_limit(data['daily_api_limit'])})}
            columns = ', '.join(f'{key} = %s' for key in data)  # whitelist above, values remain parameters
            cursor.execute(f'UPDATE users SET {columns} WHERE id = %s', (*data.values(), target))
            audit(cursor, actor, 'edit_user', target, list(data))
    finally:
        conn.close()


def reset_user(target, password, actor, is_owner):
    if not isinstance(password, str) or not 12 <= len(password) <= 200:
        raise ValueError('Use a new password of 12 to 200 characters.')
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute('SELECT email FROM users WHERE id = %s FOR UPDATE', (target,))
            row = cursor.fetchone()
            if row is None:
                raise ValueError('User not found.')
            cursor.execute('SELECT email FROM users WHERE id = %s', (actor,))
            owner = cursor.fetchone()
            if is_owner(row['email']) and not (owner and is_owner(owner['email'])):
                raise ValueError('Only a server owner can reset a server owner’s password.')
            cursor.execute('UPDATE users SET password = %s, api_key = NULL, encryption_salt = %s, session_version = session_version + 1 WHERE id = %s',
                           (generate_password_hash(password), generate_salt(), target))
            cursor.execute('DELETE FROM password_reset_tokens WHERE user_id = %s', (target,))
            audit(cursor, actor, 'reset_user_password', target, ['password', 'api_key', 'sessions'])
    finally:
        conn.close()


def _local_profile(identifier, profiles, catalog_profile=None):
    """Recover legacy metadata by exact normalized identifier; DB edits take priority."""
    from device_identity import normalize
    local = profiles.get(identifier)
    if local is None and identifier:
        matches = [profile for key, profile in profiles.items() if normalize(key) == normalize(identifier)]
        local = matches[0] if len(matches) == 1 else {}
    return {**(local or {}), **(catalog_profile or {})}


def devices():
    from device_catalog import _read, lookup_key, family_clarification
    from handlers import load_handlers_config
    from device_catalog import reset_pending
    if reset_pending():
        return []
    profiles = load_handlers_config()
    jobs = _read("SELECT * FROM device_catalog_jobs WHERE canonical_key IS NULL AND status<>'excluded' ORDER BY requested_name")
    layouts = _read("SELECT device_id, device_name, layout FROM deck_templates t WHERE is_default AND NOT EXISTS (SELECT 1 FROM device_catalog_jobs j WHERE j.device_id=t.device_id AND j.status='excluded') ORDER BY device_name")
    result, seen = [], set()
    layout_ids = {row['device_id'] for row in layouts}
    for row in jobs:
        if not row['on_demand'] and categories_for(row['profile'] or {})[:1] != ['Liquid handling']:
            continue
        profile = {} if row['reset_layout'] else _local_profile(row['device_id'], profiles, row['profile'])
        result.append({'key': row['lookup_key'], 'device_id': row['device_id'], 'device_name': row['device_name'] or row['requested_name'],
                       'identity': profile.get('identity') or {}, 'has_layout': row['device_id'] in layout_ids, 'status': row['status'], 'features': profile.get('features', []), 'search_terms': profile.get('search_terms', []), 'categories': categories_for(profile), 'constraints': profile.get('constraints', []),
                       'output_type': profile.get('output_type', ''), 'output_format': profile.get('output_format', ''), 'error': row['error'], 'clarification': family_clarification(row)})
        if row['device_id']:
            seen.add(row['device_id'])
    for row in layouts:
        if row['device_id'] in seen:
            continue
        profile = _local_profile(row['device_id'], profiles)
        result.append({'key': lookup_key(row['device_name']), 'device_id': row['device_id'], 'device_name': row['device_name'],
                       'identity': profile.get('identity') or {}, 'has_layout': True, 'status': 'local', 'features': profile.get('features', []), 'search_terms': profile.get('search_terms', []), 'categories': categories_for(profile), 'constraints': profile.get('constraints', []),
                       'output_type': profile.get('output_type', ''), 'output_format': profile.get('output_format', ''), 'error': None})
    return result


def device_detail(key):
    from device_catalog import _read, lookup_key, find_device
    from handlers import load_handlers_config
    row = find_device(key)
    if row:
        identifier = row['device_id']
        profile = {**_local_profile(identifier, load_handlers_config(), row['profile']), 'device_id':identifier, 'name':row['device_name'] or row['requested_name']}
    else:
        layout = next((entry for entry in _read('SELECT device_id, device_name FROM deck_templates WHERE is_default')
                       if lookup_key(entry['device_name']) == key), None)
        if not layout:
            raise ValueError('Device not found.')
        identifier = layout['device_id']
        profile = {**_local_profile(identifier, load_handlers_config()), 'device_id': identifier, 'name': layout['device_name']}
    profile.setdefault('categories', categories_for(profile))
    geometry = _read('SELECT layout FROM deck_templates WHERE device_id = %s AND is_default', (identifier,), one=True) if identifier else None
    return {'key': key, 'profile': profile, 'layout': geometry['layout'] if geometry else None,
            'status': row['status'] if row else 'local', 'name': (row['device_name'] or row['requested_name']) if row else profile['name']}


def validate_profile(data, previous):
    allowed = {'categories', 'features', 'constraints', 'output_type', 'output_format', 'file_extension', 'programming_interface'}
    if not isinstance(data, dict) or set(data) - allowed:
        raise ValueError('Unsupported device profile fields.')
    profile = {**previous, **data}
    for field in ('output_type', 'programming_interface'):
        if not isinstance(profile.get(field), str) or not 1 <= len(profile[field].strip()) <= 2000:
            raise ValueError('Provide the instruction format and programming interface.')
    if not isinstance(profile.get('output_format'), str) or not re.fullmatch(r'[a-z0-9_+-]{1,32}', profile['output_format']):
        raise ValueError('Invalid instruction format identifier.')
    if not isinstance(profile.get('file_extension'), str) or not re.fullmatch(r'\.[a-zA-Z0-9]{1,16}', profile['file_extension']):
        raise ValueError('Invalid instruction file extension.')
    profile['categories'] = clean_categories(profile.get('categories', categories_for(profile)))
    features, constraints = profile.get('features', []), profile.get('constraints', [])
    if not isinstance(features, list) or len(features) > 100 or any(not isinstance(item, str) or not 1 <= len(item.strip()) <= 200 for item in features):
        raise ValueError('Features must be a list of up to 100 short names.')
    if not isinstance(constraints, list) or len(constraints) > 100 or any(not isinstance(item, dict) for item in constraints) or len(json.dumps(constraints)) > 60000:
        raise ValueError('Constraints must be a JSON list of up to 100 documented rules.')
    for rule in constraints:
        if 'multiple_of' in rule and (type(rule['multiple_of']) not in (int, float) or not math.isfinite(rule['multiple_of']) or rule['multiple_of'] <= 0):
            raise ValueError('Constraint increments must be finite positive numbers.')
        for bound in ('minimum', 'maximum'):
            if bound in rule and (type(rule[bound]) not in (int, float) or not math.isfinite(rule[bound])):
                raise ValueError('Constraint bounds must be finite numbers.')
        if 'minimum' in rule and 'maximum' in rule and rule['minimum'] > rule['maximum']:
            raise ValueError('A constraint minimum cannot exceed its maximum.')
        if not isinstance(rule.get('description'), str) or not rule['description'].strip():
            raise ValueError('Each constraint needs a description including its units and scope.')
        if 'rule' in rule and rule['rule'] and not isinstance(rule['rule'], str):
            raise ValueError('Constraint expressions must be text.')
    return profile


def save_device(key, data, actor):
    from device_catalog import find_device
    canonical = find_device(key)
    key = canonical['lookup_key'] if canonical else key
    from device_catalog import _save_profile
    from deck_library import clean_layout
    if not isinstance(data, dict) or set(data) - {'profile', 'layout'}:
        raise ValueError('Unsupported device edit.')
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0)) AS locked', ('catalog-device:' + key,))
            if not cursor.fetchone()['locked']:
                raise Busy('This device is being built. Wait for discovery to finish before editing it.')
            detail = device_detail(key)
            if not detail['profile'].get('device_id'):
                raise Busy('Wait for this device’s model to be identified before editing it.')
            profile = validate_profile(data.get('profile', {}), detail['profile'])
            profile.setdefault('sources', profile.get('programming_sources', []))
            layout = clean_layout(data['layout']) if 'layout' in data else detail['layout']
            _save_profile(profile)
            if layout:
                layout['platform'] = profile['name']
                cursor.execute('UPDATE deck_templates SET layout = %s WHERE device_id = %s AND is_default', (Json(layout), profile['device_id']))
            cursor.execute("""INSERT INTO device_catalog_jobs (lookup_key, requested_name, device_id, device_name, profile, status)
                              VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (lookup_key) DO UPDATE SET profile = EXCLUDED.profile, status = EXCLUDED.status, error = NULL, reset_layout = FALSE, updated_at = NOW()""",
                           (key, profile['name'], profile['device_id'], profile['name'], Json(profile), 'ready' if layout else 'queued'))
            audit(cursor, actor, 'edit_device', key, list(data))
    finally:
        conn.close()


def update_device_database(actor, api_key):
    """Queue online rechecks and a fresh discovery pass without deleting knowledge."""
    from device_catalog import start_catalog
    from config import get_api_key
    api_key = api_key or get_api_key()
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            for lock in ('catalog-reset', 'catalog-bootstrap', 'catalog-identity-registry'):
                cursor.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS locked', (lock,))
                if not cursor.fetchone()['locked']:
                    raise Busy('Device discovery is running. Wait for it to finish before starting an update.')
            cursor.execute('SELECT lookup_key,profile FROM device_catalog_jobs WHERE canonical_key IS NULL ORDER BY lookup_key')
            devices = cursor.fetchall()
            keys = [row['lookup_key'] for row in devices]
            for key in keys:
                cursor.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS locked', ('catalog-device:' + key,))
                if not cursor.fetchone()['locked']:
                    raise Busy('A device is being edited or built. Wait for it to finish before starting an update.')
            cursor.execute("""UPDATE device_catalog_jobs SET refresh_profile=TRUE,error=NULL,updated_at=NOW(),
                status=CASE WHEN status='ready' THEN status ELSE 'queued' END WHERE canonical_key IS NULL""")
            new_limit = max(0,int(os.environ.get('BIOBOT_CATALOG_INITIAL_LIMIT','50')))
            target = sum(not row['profile'] or categories_for(row['profile'])[:1] == ['Liquid handling'] for row in devices) + new_limit if new_limit else 0
            cursor.execute("""UPDATE device_catalog_build SET status='pending',discovery_done=FALSE,
                next_query='',rounds=0,target_count=%s,updated_at=NOW() WHERE id=1""",(target,))
            audit(cursor,actor,'update_device_database','catalog',['online_checks','new_instruments'])
    finally:
        conn.close()
    start_catalog(api_key,force=True)
    return len(keys)


def reset_device_database(actor, api_key):
    """Remove the shared device inventory, retaining private work, then rediscover from scratch."""
    from device_catalog import start_catalog
    from config import get_api_key
    api_key = api_key or get_api_key()
    from handlers import load_handlers_config, _save_handlers
    import device_series
    import fcntl
    import uuid
    conn = get_db_connection()
    previous_handlers = None
    registry_cleared = False
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            for lock in ('catalog-reset', 'catalog-bootstrap', 'catalog-identity-registry'):
                cursor.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS locked', (lock,))
                if not cursor.fetchone()['locked']:
                    raise Busy('Device discovery is running. Wait for the current build to finish before resetting the database.')
            cursor.execute('SELECT lookup_key FROM device_catalog_jobs WHERE canonical_key IS NULL ORDER BY lookup_key')
            keys = [row['lookup_key'] for row in cursor.fetchall()]
            for key in keys:
                cursor.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS locked', ('catalog-device:' + key,))
                if not cursor.fetchone()['locked']:
                    raise Busy('A device is being edited or built. Wait for it to finish before resetting the database.')
            cursor.execute("SELECT id::text FROM chat_runs WHERE status='running'")
            for run in cursor.fetchall():
                cursor.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS locked', ('chat-run:' + run['id'],))
                if not cursor.fetchone()['locked']:
                    raise Busy('A protocol is being prepared. Wait for it to finish before resetting the device catalog.')
            # Protocols keep their physical layout privately; archived layouts are not inventory entries.
            cursor.execute("""SELECT DISTINCT p.user_id,t.id,t.device_id,t.device_name,t.name,t.layout
                FROM deck_protocols p JOIN deck_templates t ON t.id=p.template_id WHERE t.is_default""")
            for template in cursor.fetchall():
                identifier = str(uuid.uuid4())
                cursor.execute("""INSERT INTO deck_templates(id,device_id,device_name,name,owner_id,layout)
                    VALUES(%s,%s,%s,%s,%s,%s)""", (identifier,template['device_id'],template['device_name'],
                    template['name'] + ' (saved snapshot)',template['user_id'],Json(template['layout'])))
                cursor.execute('UPDATE deck_protocols SET template_id=%s WHERE user_id=%s AND template_id=%s',
                               (identifier,template['user_id'],template['id']))
            cursor.execute('DELETE FROM deck_templates WHERE is_default')
            cursor.execute('DELETE FROM deck_catalogs')
            cursor.execute('DELETE FROM device_catalog_aliases')
            cursor.execute('DELETE FROM device_identity_merges')
            cursor.execute('DELETE FROM device_catalog_jobs')
            cursor.execute('UPDATE chat_names SET device_job=NULL,device_job_seen=TRUE WHERE device_job IS NOT NULL')
            previous_handlers = load_handlers_config()
            if not _save_handlers({}, replace=True):
                raise ValueError('Could not clear the device profiles; the reset was cancelled.')
            registry_cleared = True
            device_series.CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            with open(str(device_series.CACHE_PATH) + '.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                device_series.CACHE_PATH.unlink(missing_ok=True)
            cursor.execute("""UPDATE device_catalog_build SET status='pending',discovery_done=FALSE,
                next_query='',rounds=0,target_count=NULL,reset_requested=FALSE,reset_actor=NULL,updated_at=NOW() WHERE id=1""")
            audit(cursor, actor, 'reset_device_database', 'catalog', ['devices', 'aliases', 'profiles', 'hardware_catalogs', 'shared_decks', 'series'])
    except Exception:
        if registry_cleared:
            _save_handlers(previous_handlers, replace=True)
        raise
    finally:
        conn.close()
    start_catalog(api_key, force=True)
    return len(keys)


def reset_device(key, actor, api_key):
    from device_catalog import find_device
    canonical = find_device(key)
    key = canonical['lookup_key'] if canonical else key
    from device_catalog import resume_device
    from config import get_api_key
    api_key = api_key or get_api_key()
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0)) AS locked', ('catalog-device:' + key,))
            if not cursor.fetchone()['locked']:
                raise Busy('This device is already being built. Wait for it to finish before resetting it.')
            detail = device_detail(key)
            cursor.execute("""INSERT INTO device_catalog_jobs (lookup_key, requested_name, reset_layout) VALUES (%s, %s, TRUE)
                              ON CONFLICT (lookup_key) DO UPDATE SET status = 'queued', profile = NULL, reset_layout = TRUE, error = NULL, updated_at = NOW()""", (key, detail['name']))
            audit(cursor, actor, 'reset_device_from_sources', key, ['profile', 'default_layout'])
    finally:
        conn.close()
    resume_device(key, api_key)


def save_layout(key, layout, actor):
    """Edit shared geometry independently of instruction-profile discovery."""
    from device_catalog import find_device
    canonical = find_device(key)
    key = canonical['lookup_key'] if canonical else key
    import uuid
    from deck_library import clean_layout
    geometry = clean_layout(layout)
    conn = get_db_connection()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute('SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0)) AS locked', ('catalog-device:' + key,))
            if not cursor.fetchone()['locked']:
                raise Busy('This device is being built. Wait for it to finish before editing its deck.')
            detail = device_detail(key)
            profile = detail['profile']
            identifier = profile.get('device_id')
            if not identifier:
                raise Busy('Wait for the device model to be identified before editing its deck.')
            geometry['platform'] = detail['name']
            cursor.execute('SELECT id FROM deck_templates WHERE device_id = %s AND is_default FOR UPDATE', (identifier,))
            existing = cursor.fetchone()
            if existing:
                cursor.execute('UPDATE deck_templates SET layout = %s WHERE id = %s', (Json(geometry), existing['id']))
            else:
                cursor.execute('INSERT INTO deck_templates (id,device_id,device_name,name,is_default,layout) VALUES (%s,%s,%s,%s,TRUE,%s)',
                               (str(uuid.uuid4()), identifier, detail['name'], detail['name'] + ' default', Json(geometry)))
            audit(cursor, actor, 'edit_device_layout', key, ['default_layout'])
    finally:
        conn.close()
