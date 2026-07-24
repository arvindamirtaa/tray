import sqlite3
import sys

run_id, sql = sys.argv[1], open("migration.sql").read()
db = sqlite3.connect("app.db")
db.isolation_level = None
already = db.execute(
    "SELECT 1 FROM _migrations WHERE id = ?", (run_id,)
).fetchone()
if already:
    print("ALREADY_APPLIED")
    sys.exit(0)
db.execute("BEGIN")
try:
    db.execute("INSERT INTO _migrations(id) VALUES (?)", (run_id,))
    db.execute(sql)
    db.execute("COMMIT")
except Exception:
    db.execute("ROLLBACK")
    raise
print("APPLIED")
