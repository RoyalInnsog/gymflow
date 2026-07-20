import re
import sqlglot

with open('routes/api.js', 'r', encoding='utf-8') as f:
    code = f.read()

# Define tables that require tenant isolation
tables_to_protect = [
    'settings', 'branches', 'staff', 'members', 'membership_plans', 
    'memberships', 'attendance', 'invoices', 'payments', 'notifications', 
    'campaigns', 'leads', 'tasks', 'retention_events', 'equipment', 
    'reports', 'activity_logs', 'templates'
]

def needs_protection(sql_str):
    sql_upper = sql_str.upper()
    for t in tables_to_protect:
        if re.search(r'\b' + t.upper() + r'\b', sql_upper):
            return True
    return False

def replacer(match):
    prefix = match.group(1)`
    sql_str = match.group(2) # e.g. SELECT ...
    suffix = match.group(3) # e.g. `, [params])

    # If it's a template literal without backticks captured properly, we handle it
    if not needs_protection(sql_str):
        return match.group(0)

    try:
        # We only use sqlglot for SELECT, UPDATE, DELETE
        sql_upper = sql_str.strip().upper()
        
        if sql_upper.startswith("INSERT"):
            # Use regex for INSERT
            new_sql = re.sub(r'(\([^)]+)\)', r"\1, tenant_id)", sql_str, count=1)
            new_sql = re.sub(r'(VALUES\s*\([^)]+)\)', r"\1, '${req.tenant_id}')", new_sql, count=1, flags=re.IGNORECASE)
            return f"{prefix}{new_sql}{suffix}"
            
        else:
            parsed = sqlglot.parse_one(sql_str, read="sqlite")
            parsed = parsed.where("tenant_id = '${req.tenant_id}'")
            new_sql = parsed.sql("sqlite")
            return f"{prefix}{new_sql}{suffix}"
    except Exception as e:
        print("Failed to parse:", sql_str, "Error:", e)
        return match.group(0)

# We match `runQuery(req, `SQL`, ...)`
# Notice that SQL can span multiple lines, so we use [^`]+
pattern = r'(Query\(req,\s*`)([^`]+)(`)'
new_code = re.sub(pattern, replacer, code)

with open('routes/api_fully_isolated.js', 'w', encoding='utf-8') as f:
    f.write(new_code)
print("Finished rewriting api_updated.js with sqlglot")
