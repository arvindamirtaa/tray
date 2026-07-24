import sqlite3

db = sqlite3.connect("app.db")
db.executescript("""
CREATE TABLE accounts(id INTEGER PRIMARY KEY, email TEXT, balance_cents INTEGER NOT NULL);
CREATE TABLE orders(id INTEGER PRIMARY KEY, account_id INTEGER, amount_cents INTEGER, status TEXT);
CREATE TABLE _migrations(id TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO accounts VALUES (4412, 'dana@example.com', 0);
INSERT INTO orders VALUES (9001, 4412, 2500, 'refund_approved');
""")
db.commit()
