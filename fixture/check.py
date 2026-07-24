import sqlite3
import sys

db = sqlite3.connect("app.db")
bad = db.execute("""
SELECT o.id, o.account_id, o.amount_cents, a.balance_cents FROM orders o
JOIN accounts a ON a.id = o.account_id
WHERE o.status = 'refund_approved' AND a.balance_cents != o.amount_cents
""").fetchall()
for row in bad:
    print(
        f"MISMATCH: order {row[0]} account {row[1]} "
        f"expected_cents {row[2]} balance_cents {row[3]}"
    )
balance = db.execute(
    "SELECT balance_cents FROM accounts WHERE id = 4412"
).fetchone()[0]
print(f"account 4412 balance_cents={balance}")
sys.exit(1 if bad else 0)
