import re
import sqlglot
from sqlglot import exp

sql = "SELECT * FROM memberships ms JOIN members m ON ms.member_id = m.id WHERE ms.status = 'Active'"
try:
    parsed = sqlglot.parse_one(sql, read="sqlite")
    tenant_cond = sqlglot.parse_one("tenant_id = '${req.tenant_id}'", read="sqlite")
    parsed = parsed.where(tenant_cond)
    print(parsed.sql("sqlite"))
except Exception as e:
    print("Error:", e)

sql2 = "UPDATE memberships SET status = 'Expired' WHERE id = ?"
try:
    parsed2 = sqlglot.parse_one(sql2, read="sqlite")
    parsed2 = parsed2.where("tenant_id = '${req.tenant_id}'")
    print(parsed2.sql("sqlite"))
except Exception as e:
    print("Error:", e)

sql3 = "INSERT INTO notifications (id, type) VALUES (?, 'Membership')"
try:
    # INSERT INTO doesn't use WHERE, we must add to columns and values
    parsed3 = sqlglot.parse_one(sql3, read="sqlite")
    # sqlglot insert rewriting is harder, maybe we handle INSERTs differently
    print(parsed3.sql("sqlite"))
except Exception as e:
    print("Error:", e)
