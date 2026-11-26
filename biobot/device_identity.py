"""Canonical physical models and verified aliases, independent of display names.

Exact verified-name bridges reconcile older records. No suffix stripping or
substring matching is used to decide whether physical models are equivalent.
"""
import hashlib
import json
import re
from psycopg2.extras import Json, RealDictCursor


def normalize(value):
    return re.sub(r'[\W_]+', '', str(value or '').casefold())


def model_key(profile):
    if profile.get('model_scope') == 'family' or profile.get('family_models'):
        raise ValueError('A product family is not an individual physical model.')
    identity = profile.get('identity')
    if not isinstance(identity, dict):
        return None
    if any(not isinstance(identity.get(field), str) or not normalize(identity[field]) for field in ('manufacturer', 'model')):
        raise ValueError('A physical model needs a documented manufacturer and model identifier.')
    variant = identity.get('variant', '')
    if not isinstance(variant, str):
        raise ValueError('The physical variant must be text.')
    return json.dumps([normalize(identity['manufacturer']), normalize(identity['model']), normalize(variant)], ensure_ascii=True)


def stable_device_id(profile):
    identity = profile['identity']
    key = model_key(profile)
    slug = '_'.join(filter(None, (re.sub(r'[^a-z0-9]+', '', identity.get(field, '').casefold()) for field in ('manufacturer', 'model', 'variant'))))
    return slug if slug and len(slug) <= 64 else (slug[:47] or 'device') + '_' + hashlib.sha256(key.encode()).hexdigest()[:16]


def init_identity_schema(cursor):
    cursor.execute('''
        ALTER TABLE device_catalog_jobs ADD COLUMN IF NOT EXISTS canonical_key TEXT REFERENCES device_catalog_jobs(lookup_key);
        ALTER TABLE device_catalog_jobs ADD COLUMN IF NOT EXISTS model_key TEXT;
        CREATE TABLE IF NOT EXISTS device_catalog_aliases (
            alias_key TEXT PRIMARY KEY,
            lookup_key TEXT NOT NULL REFERENCES device_catalog_jobs(lookup_key)
        );
        CREATE TABLE IF NOT EXISTS device_identity_merges (
            id BIGSERIAL PRIMARY KEY, source_key TEXT NOT NULL, target_key TEXT NOT NULL,
            previous_record JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS device_unique_physical_model ON device_catalog_jobs(model_key)
            WHERE canonical_key IS NULL AND model_key IS NOT NULL;
    ''')


def canonical_row(cursor, row):
    seen = set()
    while row and row.get('canonical_key'):
        if row['lookup_key'] in seen:
            raise ValueError('Invalid device alias cycle.')
        seen.add(row['lookup_key'])
        cursor.execute('SELECT * FROM device_catalog_jobs WHERE lookup_key=%s', (row['canonical_key'],))
        row = cursor.fetchone()
    return dict(row) if row else None


def lookup(cursor, name):
    key = normalize(name)
    cursor.execute('''SELECT * FROM device_catalog_jobs WHERE lookup_key = COALESCE(
        (SELECT lookup_key FROM device_catalog_aliases WHERE alias_key=%s), %s)''', (key, key))
    return canonical_row(cursor, cursor.fetchone())


def _names(row):
    profile = row.get('profile') or {}
    return [row.get('requested_name'), row.get('device_name'), row.get('device_id'), profile.get('name'), *(profile.get('aliases') or [])]


def register_aliases(cursor, row, names=()):
    for name in [*_names(row), *names]:
        key = normalize(name)
        if not key:
            continue
        existing = lookup(cursor, name)
        if existing and existing['lookup_key'] != row['lookup_key']:
            raise ValueError('This device name is already assigned to a different physical model.')
        cursor.execute('''INSERT INTO device_catalog_aliases(alias_key,lookup_key) VALUES (%s,%s)
            ON CONFLICT(alias_key) DO UPDATE SET lookup_key=EXCLUDED.lookup_key''', (key, row['lookup_key']))


def preferred(cursor, rows):
    def score(row):
        cursor.execute('''SELECT COALESCE(SUM((SELECT COUNT(*) FROM deck_protocols p WHERE p.template_id=t.id)),0) AS refs,
            MIN(t.created_at) AS oldest FROM deck_templates t WHERE device_id=%s AND is_default''', (row.get('device_id'),))
        facts = cursor.fetchone()
        cursor.execute("SELECT to_regclass('admin_audit') AS audit_table")
        edited = 0
        if cursor.fetchone()['audit_table']:
            cursor.execute("SELECT COUNT(*) AS n FROM admin_audit WHERE target=%s AND action IN ('edit_device','edit_device_layout')", (row['lookup_key'],))
            edited = cursor.fetchone()['n']
        age = facts['oldest'].timestamp() if facts['oldest'] else float('inf')
        return (row['status'] == 'building' and bool(row.get('model_key')), edited > 0, int(facts['refs']), row['status'] == 'ready', -age, row['lookup_key'])
    return max(rows, key=score)


def merge(cursor, target, source, *, correction_evidence=None):
    if target['lookup_key'] == source['lookup_key']:
        return target
    if not correction_evidence and target.get('model_key') and source.get('model_key') and target['model_key'] != source['model_key']:
        raise ValueError('Different physical models cannot be merged through a shared label.')
    signature = target.get('model_key') or source.get('model_key')
    if source.get('on_demand'):
        cursor.execute('UPDATE device_catalog_jobs SET on_demand=TRUE WHERE lookup_key=%s',(target['lookup_key'],))
    target_id, source_id = target.get('device_id'), source.get('device_id')
    if not target_id:
        target_id = source_id
    name = target.get('device_name') or target['requested_name']
    cursor.execute('INSERT INTO device_identity_merges(source_key,target_key,previous_record) VALUES (%s,%s,%s)',
                   (source['lookup_key'], target['lookup_key'], Json(json.loads(json.dumps({**dict(source), **({'correction_evidence':correction_evidence} if correction_evidence else {})}, default=str)))))
    if source_id and target_id and source_id != target_id:
        cursor.execute('SELECT id FROM deck_templates WHERE device_id=%s AND is_default', (target_id,))
        has_default = cursor.fetchone() is not None
        if has_default:
            # Former defaults remain selectable shared alternatives, with their UUIDs and contents intact.
            cursor.execute("UPDATE deck_templates SET is_default=FALSE,published=TRUE,name=LEFT(name,95)||' (previous default)' WHERE device_id=%s AND is_default", (source_id,))
        cursor.execute("UPDATE deck_templates SET device_id=%s,device_name=%s,layout=jsonb_set(layout,'{platform}',%s::jsonb) WHERE device_id=%s", (target_id, name, json.dumps(name), source_id))
        cursor.execute('UPDATE deck_protocols SET device_id=%s WHERE device_id=%s', (target_id, source_id))
    if source_id:
        for old_name in (source.get('device_name'), source.get('requested_name')):
            if old_name and normalize(old_name) != normalize(name):
                cursor.execute('UPDATE chat_names SET device_name=%s WHERE device_name=%s', (name, old_name))
                cursor.execute('UPDATE saved_protocols SET device_name=%s WHERE device_name=%s', (name, old_name))
    profile = target.get('profile') or {}
    incoming = source.get('profile') or {}
    if not profile.get('programming_interface') and incoming.get('programming_interface'):
        profile = dict(incoming)
    if incoming.get('identity') and not profile.get('identity'):
        profile = {**profile, 'identity': incoming['identity']}
    if profile:
        profile = {**profile, 'device_id': target_id, 'name': name}
    cursor.execute('UPDATE device_catalog_jobs SET canonical_key=%s WHERE canonical_key=%s', (target['lookup_key'], source['lookup_key']))
    cursor.execute('UPDATE device_catalog_aliases SET lookup_key=%s WHERE lookup_key=%s', (target['lookup_key'], source['lookup_key']))
    cursor.execute('UPDATE device_catalog_jobs SET canonical_key=%s,model_key=NULL WHERE lookup_key=%s', (target['lookup_key'], source['lookup_key']))
    cursor.execute('''UPDATE device_catalog_jobs SET device_id=%s, device_name=%s, profile=%s, model_key=%s,
        status=CASE WHEN status='ready' OR %s='ready' THEN 'ready' ELSE status END, updated_at=NOW()
        WHERE lookup_key=%s RETURNING *''', (target_id, name, Json(profile) if profile else None, signature, source['status'], target['lookup_key']))
    target = dict(cursor.fetchone())
    return target


def reconcile_existing(cursor):
    """Consolidate exact verified-name bridges and retain every saved layout."""
    cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('catalog-identity-registry',0))")
    cursor.execute('SELECT DISTINCT device_id,device_name FROM deck_templates WHERE is_default')
    layouts = cursor.fetchall()
    for item in layouts:
        cursor.execute('SELECT 1 FROM device_catalog_jobs WHERE device_id=%s', (item['device_id'],))
        if cursor.fetchone():
            continue
        key = normalize(item['device_name'])
        existing = lookup(cursor,item['device_name'])
        if existing and existing.get('device_id') != item['device_id']:
            key = 'legacy' + hashlib.sha256(item['device_id'].encode()).hexdigest()[:32]
        cursor.execute('''INSERT INTO device_catalog_jobs(lookup_key,requested_name,device_name,device_id,status)
            VALUES (%s,%s,%s,%s,'ready') ON CONFLICT(lookup_key) DO NOTHING''', (key,item['device_name'],item['device_name'],item['device_id']))
    cursor.execute('SELECT * FROM device_catalog_jobs WHERE canonical_key IS NULL ORDER BY lookup_key')
    roots = [dict(row) for row in cursor.fetchall()]
    # Connected components of exact names, verified aliases and identifiers. Never fuzzy-match a model prefix.
    groups = []
    for row in roots:
        keys = {normalize(name) for name in _names(row) if normalize(name)}
        matching = [group for group in groups if group[0] & keys]
        members = [row]
        for group in matching:
            keys |= group[0]; members += group[1]; groups.remove(group)
        groups.append((keys,members))
    for _, members in groups:
        target = preferred(cursor,members)
        for source in members:
            if source['lookup_key'] != target['lookup_key']:
                target = merge(cursor,target,source)
        register_aliases(cursor,target,[name for member in members for name in _names(member)])
    cursor.execute('''CREATE UNIQUE INDEX IF NOT EXISTS device_unique_canonical_id ON device_catalog_jobs(device_id)
        WHERE canonical_key IS NULL AND device_id IS NOT NULL''')


def claim_profile(cursor, key, profile, refresh=False):
    """Serialize identity assignment before any device geometry is generated."""
    cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('catalog-identity-registry',0))")
    cursor.execute('SELECT * FROM device_catalog_jobs WHERE lookup_key=%s', (key,))
    original = canonical_row(cursor,cursor.fetchone())
    signature = model_key(profile)
    matches = {original['lookup_key']: original}
    established = None
    if signature:
        cursor.execute('SELECT * FROM device_catalog_jobs WHERE model_key=%s AND canonical_key IS NULL', (signature,))
        found = cursor.fetchone()
        if found:
            established = dict(found)
            matches[found['lookup_key']] = established
    for name in [profile['name'], profile['device_id'], *(profile.get('aliases') or [])]:
        found = lookup(cursor,name)
        if found:
            matches[found['lookup_key']] = found
    for row in matches.values():
        if signature and row.get('model_key') and row['model_key'] != signature:
            raise ValueError('Discovery reused a name belonging to a different physical model.')
    target = established or preferred(cursor,list(matches.values()))
    for source in matches.values():
        if source['lookup_key'] != target['lookup_key']:
            target = merge(cursor,target,source)
    identifier = target.get('device_id') or (stable_device_id(profile) if signature else profile['device_id'])
    old_name = target.get('device_name') or target['requested_name']
    name = old_name if target.get('model_key') else profile['name']
    previous = target.get('profile') or {}
    if target['status'] == 'ready' and previous.get('programming_interface'):
        evidence = previous.get('sources', []) + [source for source in profile.get('sources', []) if source not in previous.get('sources', [])]
        preserve_edits = True
        if refresh:
            cursor.execute("SELECT to_regclass('admin_audit') AS audit_table")
            preserve_edits = False
            if cursor.fetchone()['audit_table']:
                cursor.execute("""SELECT 1 FROM admin_audit WHERE target=%s AND action='edit_device'
                    AND id > COALESCE((SELECT MAX(id) FROM admin_audit WHERE action='reset_device_database'
                        OR (action='reset_device_from_sources' AND target=%s)),0) LIMIT 1""",
                    (target['lookup_key'],target['lookup_key']))
                preserve_edits = cursor.fetchone() is not None
        merged = {**profile, **previous} if preserve_edits else {**previous, **profile}
        profile = {**merged, 'identity': profile.get('identity') or previous.get('identity'),
                   'aliases': sorted(set(previous.get('aliases', []) + profile.get('aliases', []))), 'sources': evidence}
    profile['aliases'] = sorted({alias for member in matches.values() for alias in [member.get('requested_name'),member.get('device_name'),*(profile.get('aliases') or [])] if alias})
    profile = {**profile,'device_id':identifier,'name':name}
    cursor.execute('UPDATE device_catalog_jobs SET device_id=%s,device_name=%s,profile=%s,model_key=%s,updated_at=NOW() WHERE lookup_key=%s RETURNING *',
                   (identifier,name,Json(profile),signature,target['lookup_key']))
    target = dict(cursor.fetchone())
    if name != old_name:
        cursor.execute("UPDATE deck_templates SET device_name=%s,layout=jsonb_set(layout,'{platform}',%s::jsonb) WHERE device_id=%s",(name,json.dumps(name),identifier))
        cursor.execute('UPDATE chat_names SET device_name=%s WHERE device_name=%s',(name,old_name))
        cursor.execute('UPDATE saved_protocols SET device_name=%s WHERE device_name=%s',(name,old_name))
    register_aliases(cursor,target,[original['requested_name'],profile['name'],*(profile.get('aliases') or []),*[name for member in matches.values() for name in _names(member)]])
    return target


def cached_device(cursor, device):
    row = lookup(cursor,device['name']) or lookup(cursor,device['device_id'])
    return {'device_id':row['device_id'],'name':row['device_name'] or row['requested_name']} if row and row.get('device_id') else device


def register_cached_device(cursor, identifier, name):
    """Register legacy/protocol-created physical defaults in the same alias registry."""
    cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('catalog-identity-registry',0))")
    row = lookup(cursor,name) or lookup(cursor,identifier)
    if row is None:
        cursor.execute("""INSERT INTO device_catalog_jobs(lookup_key,requested_name,device_id,device_name,status)
            VALUES (%s,%s,%s,%s,'ready') ON CONFLICT(lookup_key) DO NOTHING RETURNING *""", (normalize(name),name,identifier,name))
        row = cursor.fetchone()
    if row:
        register_aliases(cursor,dict(row),[name,identifier])


def correct_model_assignment(cursor, source_key, target_key, position_map, evidence):
    """Apply an explicitly reviewed identity correction, retaining layouts and an audit trail.

    Discovery never calls this: different physical identities cannot be merged automatically.
    Only bindings using the superseded shared default move; private/selected copies remain intact.
    """
    if not isinstance(evidence, str) or not evidence.strip():
        raise ValueError('A model correction requires reviewed source evidence.')
    cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('catalog-identity-registry',0))")
    cursor.execute('SELECT * FROM device_catalog_jobs WHERE lookup_key=%s FOR UPDATE', (source_key,))
    row = cursor.fetchone()
    if not row:
        raise ValueError('Source device not found.')
    source = dict(row)
    if source.get('canonical_key') == target_key:
        return
    cursor.execute('SELECT * FROM device_catalog_jobs WHERE lookup_key=%s AND canonical_key IS NULL FOR UPDATE', (target_key,))
    row = cursor.fetchone()
    if not row or source.get('canonical_key'):
        raise ValueError('Choose two existing canonical device records.')
    target = dict(row)
    cursor.execute('SELECT * FROM deck_templates WHERE device_id=%s AND is_default', (source['device_id'],))
    previous = cursor.fetchone()
    cursor.execute('SELECT * FROM deck_templates WHERE device_id=%s AND is_default', (target['device_id'],))
    current = cursor.fetchone()
    if not previous or not current:
        raise ValueError('Both devices must have a saved default deck.')
    old_ids = {p['id'] for p in previous['layout'].get('positions', [])}
    new_ids = {p['id'] for p in current['layout'].get('positions', [])}
    if set(position_map) != old_ids or not set(position_map.values()) <= new_ids or len(set(position_map.values())) != len(position_map):
        raise ValueError('Provide an unambiguous mapping for every previous physical position.')
    def remap(value, field=None):
        if isinstance(value, dict):
            return {key:remap(child,key) for key,child in value.items()}
        if isinstance(value, list):
            return [remap(child,field) for child in value]
        return position_map.get(value,value) if isinstance(value,str) and field in {'id','slot','position'} else value
    cursor.execute('SELECT user_id,code_hash,binding FROM deck_protocols WHERE template_id=%s FOR UPDATE', (previous['id'],))
    protocols = cursor.fetchall()
    source['corrected_protocol_bindings'] = [dict(protocol) for protocol in protocols]
    for protocol in protocols:
        binding = remap(protocol['binding'])
        for position in binding.get('positions', []):
            position.pop('module', None)  # Physical hardware comes from the reviewed replacement deck.
        if binding.get('instruments') == previous['layout'].get('instruments'):
            binding.pop('instruments', None)
        cursor.execute('UPDATE deck_protocols SET template_id=%s,device_id=%s,binding=%s WHERE user_id=%s AND code_hash=%s',
                       (current['id'],target['device_id'],Json(binding),protocol['user_id'],protocol['code_hash']))
    target = merge(cursor,target,source,correction_evidence=evidence)
    register_aliases(cursor,target,_names(source))
