"""
ExpenseIQ Family Edition
Flask + MySQL
Each family member has completely isolated expenses, income, and balance.
Members are stored in the DB — add/remove from the MEMBERS list below.
"""

from flask import Flask, render_template, request, jsonify, Response, session, redirect, url_for
from flask_cors import CORS
import mysql.connector
from mysql.connector import pooling
import csv, io, decimal, hashlib
from datetime import datetime, date
import os

app = Flask(__name__)
app.secret_key = "78e03b5f34266d7d278fbe719613818a2c90f6cb26603c5d6f7000ccba112fc5"   # change in production
CORS(app)

# ─────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────

DB_CONFIG = {
    "host": os.getenv("MYSQLHOST"),
    "user": os.getenv("MYSQLUSER"),
    "password": os.getenv("MYSQLPASSWORD"),
    "database": os.getenv("MYSQLDATABASE"),
    "port": int(os.getenv("MYSQLPORT"))
}

# Family members — edit names here to add/remove members
MEMBERS = ["Vijay", "Prasanna", "Tharun"]

# Color theme per member (used on family page cards)
MEMBER_COLORS = {
    "Vijay":    {"accent": "#5c9eff", "glow": "rgba(92,158,255,0.18)"},
    "Prasanna": {"accent": "#4cef88", "glow": "rgba(76,239,136,0.18)"},
    "Tharun":   {"accent": "#f0a500", "glow": "rgba(240,165,0,0.18)"},
}

# ─────────────────────────────────────────
# CONNECTION POOL
# ─────────────────────────────────────────

_pool = None

def get_pool():
    global _pool
    if _pool is None:
        _pool = pooling.MySQLConnectionPool(
            pool_name="expenseiq_family_pool",
            pool_size=10,
            **DB_CONFIG
        )
    return _pool

def get_db():
    return get_pool().get_connection()

def query(conn, sql, params=None, fetch="all"):
    cur = conn.cursor(dictionary=True)
    cur.execute(sql, params or ())
    if fetch == "all":   return cur.fetchall()
    if fetch == "one":   return cur.fetchone()
    lid = cur.lastrowid
    cur.close()
    return lid

# ─────────────────────────────────────────
# SAFE JSON (Decimal / date → serialisable)
# ─────────────────────────────────────────

def safe(data):
    if isinstance(data, list):  return [safe(r) for r in data]
    if isinstance(data, dict):
        out = {}
        for k, v in data.items():
            if isinstance(v, decimal.Decimal):       out[k] = float(v)
            elif isinstance(v, (datetime, date)):    out[k] = str(v)
            else:                                    out[k] = v
        return out
    return data

# ─────────────────────────────────────────
# DATABASE INIT
# ─────────────────────────────────────────

def init_db():
    """
    Create database + tables.
    Every table has a `member` column so all family data lives in one DB
    but is completely isolated per member.
    """
    cfg = {k: v for k, v in DB_CONFIG.items() if k != "database"}
    conn = mysql.connector.connect(**cfg)
    cur = conn.cursor()

    cur.execute(
        f"CREATE DATABASE IF NOT EXISTS `{DB_CONFIG['database']}` "
        f"CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    )
    cur.execute(f"USE `{DB_CONFIG['database']}`")

    # members registry
    cur.execute("""
        CREATE TABLE IF NOT EXISTS members (
            id         INT          AUTO_INCREMENT PRIMARY KEY,
            name       VARCHAR(100) NOT NULL UNIQUE,
            color      VARCHAR(20)  DEFAULT '#5c9eff',
            created_at DATETIME     DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # expenses — member column isolates per user
    cur.execute("""
        CREATE TABLE IF NOT EXISTS expenses (
            id         INT            AUTO_INCREMENT PRIMARY KEY,
            member     VARCHAR(100)   NOT NULL,
            title      VARCHAR(255)   NOT NULL,
            amount     DECIMAL(12,2)  NOT NULL,
            category   VARCHAR(100)   NOT NULL,
            location   VARCHAR(255),
            reason     TEXT,
            datetime   DATETIME       NOT NULL,
            created_at DATETIME       DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_member (member),
            INDEX idx_member_date (member, datetime)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # budgets
    cur.execute("""
        CREATE TABLE IF NOT EXISTS budgets (
            id            INT            AUTO_INCREMENT PRIMARY KEY,
            member        VARCHAR(100)   NOT NULL,
            category      VARCHAR(100)   NOT NULL,
            monthly_limit DECIMAL(12,2)  NOT NULL,
            updated_at    DATETIME       DEFAULT CURRENT_TIMESTAMP
                                         ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY unique_member_cat (member, category),
            INDEX idx_member (member)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # income
    cur.execute("""
        CREATE TABLE IF NOT EXISTS income (
            id         INT            AUTO_INCREMENT PRIMARY KEY,
            member     VARCHAR(100)   NOT NULL,
            amount     DECIMAL(12,2)  NOT NULL,
            source     VARCHAR(100),
            date       DATE           NOT NULL,
            note       VARCHAR(500),
            created_at DATETIME       DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_member (member)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # balance — one row per member
    cur.execute("""
        CREATE TABLE IF NOT EXISTS balance (
            member       VARCHAR(100)   PRIMARY KEY,
            total_amount DECIMAL(14,2)  NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── Family login table (single shared password for all members) ──
    cur.execute("""
        CREATE TABLE IF NOT EXISTS family_auth (
            id            INT          PRIMARY KEY DEFAULT 1,
            password_hash VARCHAR(64)  NOT NULL,
            updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Default password is "family123" — hashed with SHA-256
    default_hash = hashlib.sha256("family123".encode()).hexdigest()
    cur.execute(
        "INSERT IGNORE INTO family_auth (id, password_hash) VALUES (1, %s)",
        (default_hash,)
    )

    # Seed members and their balance rows
    for name in MEMBERS:
        color = MEMBER_COLORS.get(name, {}).get("accent", "#5c9eff")
        cur.execute(
            "INSERT IGNORE INTO members (name, color) VALUES (%s, %s)",
            (name, color)
        )
        cur.execute(
            "INSERT IGNORE INTO balance (member, total_amount) VALUES (%s, 0)",
            (name,)
        )

    conn.commit()
    cur.close()
    conn.close()
    print("✅ ExpenseIQ Family DB ready.")

# ─────────────────────────────────────────
# AUTH HELPERS
# ─────────────────────────────────────────

def hash_password(pw):
    """SHA-256 hash of the password string."""
    return hashlib.sha256(pw.encode()).hexdigest()

def check_family_password(conn, pw):
    """Return True if pw matches the stored family password."""
    row = query(conn,
        "SELECT password_hash FROM family_auth WHERE id=1", fetch="one")
    if not row:
        return False
    return row["password_hash"] == hash_password(pw)

def is_family_logged_in():
    """True if the family password session is active."""
    return session.get("family_auth") is True

def require_family_login():
    """Redirect to login page if family is not authenticated."""
    if not is_family_logged_in():
        return redirect(url_for("login_page"))
    return None

# ─────────────────────────────────────────
# BALANCE HELPERS
# ─────────────────────────────────────────

def get_balance(conn, member):
    row = query(conn,
        "SELECT total_amount FROM balance WHERE member=%s", (member,), fetch="one")
    return float(row["total_amount"]) if row else 0.0

def adjust_balance(conn, member, delta):
    query(conn,
        "UPDATE balance SET total_amount = total_amount + %s WHERE member=%s",
        (delta, member), fetch="none")
    return get_balance(conn, member)

# ─────────────────────────────────────────
# FILTER BUILDERS
# ─────────────────────────────────────────

def build_expense_filters(args):
    conds, params = ["member = %s"], []   # member always first
    if args.get("category") and args["category"] != "all":
        conds.append("category = %s"); params.append(args["category"])
    if args.get("date_from"):
        conds.append("datetime >= %s"); params.append(args["date_from"])
    if args.get("date_to"):
        conds.append("datetime <= %s"); params.append(args["date_to"] + " 23:59:59")
    if args.get("amount_min"):
        conds.append("amount >= %s"); params.append(float(args["amount_min"]))
    if args.get("amount_max"):
        conds.append("amount <= %s"); params.append(float(args["amount_max"]))
    if args.get("search"):
        kw = f"%{args['search']}%"
        conds.append("(title LIKE %s OR location LIKE %s OR reason LIKE %s)")
        params.extend([kw, kw, kw])
    return "WHERE " + " AND ".join(conds), params

def build_income_filters(args):
    conds, params = ["member = %s"], []
    if args.get("source") and args["source"] != "all":
        conds.append("source = %s"); params.append(args["source"])
    if args.get("date_from"):
        conds.append("date >= %s"); params.append(args["date_from"])
    if args.get("date_to"):
        conds.append("date <= %s"); params.append(args["date_to"])
    if args.get("amount_min"):
        conds.append("amount >= %s"); params.append(float(args["amount_min"]))
    if args.get("amount_max"):
        conds.append("amount <= %s"); params.append(float(args["amount_max"]))
    if args.get("search"):
        kw = f"%{args['search']}%"
        conds.append("(source LIKE %s OR note LIKE %s)")
        params.extend([kw, kw])
    return "WHERE " + " AND ".join(conds), params

def get_member_or_400():
    """Read member from session; return (member, None) or (None, error response)."""
    member = session.get("member")
    if not member or member not in MEMBERS:
        return None, (jsonify({"error": "Not logged in"}), 401)
    return member, None

# ─────────────────────────────────────────
# PAGES
# ─────────────────────────────────────────

@app.route("/")
def login_page():
    """
    Family login screen — shown to everyone first.
    If already authenticated, go straight to family selection.
    """
    if is_family_logged_in():
        return redirect(url_for("family_home"))
    return render_template("login.html")


@app.route("/login", methods=["POST"])
def do_login():
    """Verify family password and set session."""
    data = request.get_json()
    pw   = (data or {}).get("password", "")
    if not pw:
        return jsonify({"error": "Password is required"}), 400

    conn = get_db()
    ok   = check_family_password(conn, pw)
    conn.close()

    if ok:
        session["family_auth"] = True
        return jsonify({"success": True})
    return jsonify({"error": "Incorrect password. Try again."}), 401


@app.route("/family")
def family_home():
    """Family member selection screen — requires login."""
    redir = require_family_login()
    if redir: return redir

    members_data = []
    for name in MEMBERS:
        colors = MEMBER_COLORS.get(name, {"accent": "#5c9eff", "glow": "rgba(92,158,255,0.18)"})
        members_data.append({"name": name, **colors})
    return render_template("family.html", members=members_data)


@app.route("/select/<name>")
def select_member(name):
    """Set the active member in session and redirect to dashboard."""
    redir = require_family_login()
    if redir: return redir
    if name not in MEMBERS:
        return redirect(url_for("family_home"))
    session["member"] = name
    return redirect(url_for("dashboard_page"))


@app.route("/dashboard")
def dashboard_page():
    """Main app page — requires login + member selected."""
    redir = require_family_login()
    if redir: return redir
    member = session.get("member")
    if not member or member not in MEMBERS:
        return redirect(url_for("family_home"))
    colors = MEMBER_COLORS.get(member, {"accent": "#5c9eff", "glow": "rgba(92,158,255,0.18)"})
    return render_template("index.html", member=member, colors=colors)


@app.route("/logout")
def logout():
    """Log out of member dashboard — back to family selection (still logged in)."""
    session.pop("member", None)
    return redirect(url_for("family_home"))


@app.route("/family-logout")
def family_logout():
    """Full logout — clears everything, back to login screen."""
    session.clear()
    return redirect(url_for("login_page"))


# ─────────────────────────────────────────
# API — CHANGE PASSWORD
# ─────────────────────────────────────────

@app.route("/api/change-password", methods=["POST"])
def change_password():
    """
    POST /api/change-password
    Body: { current_password, new_password, confirm_password }
    Any logged-in family member can change the shared password.
    """
    if not is_family_logged_in():
        return jsonify({"error": "Not authenticated"}), 401

    data = request.get_json() or {}
    current = data.get("current_password", "")
    new_pw  = data.get("new_password", "")
    confirm = data.get("confirm_password", "")

    if not current or not new_pw or not confirm:
        return jsonify({"error": "All fields are required"}), 400
    if new_pw != confirm:
        return jsonify({"error": "New passwords do not match"}), 400
    if len(new_pw) < 4:
        return jsonify({"error": "Password must be at least 4 characters"}), 400

    conn = get_db()
    if not check_family_password(conn, current):
        conn.close()
        return jsonify({"error": "Current password is incorrect"}), 401

    new_hash = hash_password(new_pw)
    query(conn,
        "UPDATE family_auth SET password_hash=%s WHERE id=1",
        (new_hash,), fetch="none")
    conn.commit()
    conn.close()
    return jsonify({"success": True, "message": "Password changed successfully!"})

# ─────────────────────────────────────────
# API — EXPENSES
# ─────────────────────────────────────────

@app.route("/api/expenses", methods=["GET"])
def get_expenses():
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    where, params = build_expense_filters(request.args)
    rows = query(conn,
        f"SELECT * FROM expenses {where} ORDER BY datetime DESC",
        [member] + params)
    conn.close()
    return jsonify(safe(rows))


@app.route("/api/expenses", methods=["POST"])
def add_expense():
    member, err = get_member_or_400()
    if err: return err
    data = request.get_json()
    for f in ["title", "amount", "category", "datetime"]:
        if not data.get(f):
            return jsonify({"error": f"'{f}' is required"}), 400

    amount = float(data["amount"])
    conn = get_db()
    bal = get_balance(conn, member)
    if bal < amount:
        conn.close()
        return jsonify({
            "error": f"Insufficient balance! Available: ₹{bal:.2f}, Required: ₹{amount:.2f}",
            "insufficient": True, "balance": bal
        }), 400

    new_id = query(conn,
        "INSERT INTO expenses (member,title,amount,category,location,reason,datetime) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (member, data["title"], amount, data["category"],
         data.get("location",""), data.get("reason",""), data["datetime"]),
        fetch="none")
    new_balance = adjust_balance(conn, member, -amount)
    conn.commit()
    alert = check_budget_alert(conn, member, data["category"])
    conn.close()
    return jsonify({"id": new_id, "alert": alert, "new_balance": new_balance}), 201


@app.route("/api/expenses/<int:eid>", methods=["PUT"])
def update_expense(eid):
    member, err = get_member_or_400()
    if err: return err
    data = request.get_json()
    new_amt = float(data["amount"])
    conn = get_db()
    old = query(conn,
        "SELECT amount FROM expenses WHERE id=%s AND member=%s",
        (eid, member), fetch="one")
    if old:
        adjust_balance(conn, member, float(old["amount"]) - new_amt)
    query(conn,
        "UPDATE expenses SET title=%s,amount=%s,category=%s,location=%s,reason=%s,datetime=%s "
        "WHERE id=%s AND member=%s",
        (data["title"], new_amt, data["category"],
         data.get("location",""), data.get("reason",""),
         data["datetime"], eid, member), fetch="none")
    conn.commit()
    nb = get_balance(conn, member)
    conn.close()
    return jsonify({"success": True, "new_balance": nb})


@app.route("/api/expenses/<int:eid>", methods=["DELETE"])
def delete_expense(eid):
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    row = query(conn,
        "SELECT amount FROM expenses WHERE id=%s AND member=%s",
        (eid, member), fetch="one")
    if row:
        adjust_balance(conn, member, float(row["amount"]))
    query(conn, "DELETE FROM expenses WHERE id=%s AND member=%s",
          (eid, member), fetch="none")
    conn.commit()
    nb = get_balance(conn, member)
    conn.close()
    return jsonify({"success": True, "new_balance": nb})

# ─────────────────────────────────────────
# API — DASHBOARD
# ─────────────────────────────────────────

@app.route("/api/dashboard")
def dashboard():
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    today       = date.today().isoformat()
    month_start = date.today().replace(day=1).isoformat()
    m = member   # shorthand

    today_total = float(query(conn,
        "SELECT COALESCE(SUM(amount),0) AS t FROM expenses "
        "WHERE member=%s AND DATE(datetime)=%s", (m, today), fetch="one")["t"])

    month_total = float(query(conn,
        "SELECT COALESCE(SUM(amount),0) AS t FROM expenses "
        "WHERE member=%s AND DATE(datetime)>=%s", (m, month_start), fetch="one")["t"])

    all_total = float(query(conn,
        "SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE member=%s",
        (m,), fetch="one")["t"])

    today_count = query(conn,
        "SELECT COUNT(*) AS c FROM expenses WHERE member=%s AND DATE(datetime)=%s",
        (m, today), fetch="one")["c"]

    cat_rows = query(conn,
        "SELECT category, SUM(amount) AS total FROM expenses "
        "WHERE member=%s AND DATE(datetime)>=%s "
        "GROUP BY category ORDER BY total DESC", (m, month_start))
    categories = [{"category": r["category"], "total": float(r["total"])} for r in cat_rows]

    daily_rows = query(conn,
        "SELECT DATE(datetime) AS day, SUM(amount) AS total FROM expenses "
        "WHERE member=%s AND DATE(datetime) >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) "
        "GROUP BY day ORDER BY day", (m,))
    daily = [{"day": str(r["day"]), "total": float(r["total"])} for r in daily_rows]

    avg_row = query(conn,
        "SELECT COALESCE(AVG(dt),0) AS avg FROM "
        "(SELECT SUM(amount) AS dt FROM expenses "
        "WHERE member=%s AND DATE(datetime)>=DATE_SUB(CURDATE(),INTERVAL 30 DAY) "
        "GROUP BY DATE(datetime)) sub", (m,), fetch="one")
    daily_avg = float(avg_row["avg"])

    top = query(conn,
        "SELECT category, SUM(amount) AS total FROM expenses WHERE member=%s "
        "GROUP BY category ORDER BY total DESC LIMIT 1", (m,), fetch="one")
    top_category = {"category": top["category"], "total": float(top["total"])} if top else {}

    balance = get_balance(conn, m)

    month_income = float(query(conn,
        "SELECT COALESCE(SUM(amount),0) AS t FROM income WHERE member=%s AND date>=%s",
        (m, month_start), fetch="one")["t"])

    conn.close()
    return jsonify({
        "today_total": today_total, "month_total": month_total,
        "all_total": all_total,     "today_count": today_count,
        "daily_avg": daily_avg,     "top_category": top_category,
        "categories": categories,   "daily_trend": daily,
        "balance": balance,         "month_income": month_income,
        "member": member,
    })


@app.route("/api/analytics/monthly")
def monthly_analytics():
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    rows = query(conn,
        "SELECT DATE_FORMAT(datetime,'%Y-%m') AS month, SUM(amount) AS total "
        "FROM expenses WHERE member=%s "
        "GROUP BY month ORDER BY month DESC LIMIT 12", (member,))
    conn.close()
    return jsonify([{"month": r["month"], "total": float(r["total"])} for r in rows])

# ─────────────────────────────────────────
# API — BUDGETS
# ─────────────────────────────────────────

@app.route("/api/budgets", methods=["GET"])
def get_budgets():
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    rows = query(conn, "SELECT * FROM budgets WHERE member=%s", (member,))
    month_start = date.today().replace(day=1).isoformat()
    result = []
    for r in rows:
        sp = query(conn,
            "SELECT COALESCE(SUM(amount),0) AS s FROM expenses "
            "WHERE member=%s AND category=%s AND DATE(datetime)>=%s",
            (member, r["category"], month_start), fetch="one")
        d = safe(dict(r))
        d["spent"] = float(sp["s"])
        result.append(d)
    conn.close()
    return jsonify(result)


@app.route("/api/budgets", methods=["POST"])
def set_budget():
    member, err = get_member_or_400()
    if err: return err
    data = request.get_json()
    conn = get_db()
    query(conn,
        "INSERT INTO budgets (member,category,monthly_limit) VALUES (%s,%s,%s) "
        "ON DUPLICATE KEY UPDATE monthly_limit=VALUES(monthly_limit)",
        (member, data["category"], float(data["monthly_limit"])), fetch="none")
    conn.commit()
    conn.close()
    return jsonify({"success": True})

# ─────────────────────────────────────────
# API — BALANCE
# ─────────────────────────────────────────

@app.route("/api/balance", methods=["GET"])
def get_balance_route():
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    b = get_balance(conn, member)
    conn.close()
    return jsonify({"balance": b})


@app.route("/api/balance/set", methods=["POST"])
def set_balance_route():
    member, err = get_member_or_400()
    if err: return err
    data = request.get_json()
    amount = float(data.get("amount", 0))
    conn = get_db()
    query(conn,
        "UPDATE balance SET total_amount=%s WHERE member=%s",
        (amount, member), fetch="none")
    conn.commit()
    conn.close()
    return jsonify({"success": True, "balance": amount})

# ─────────────────────────────────────────
# API — INCOME
# ─────────────────────────────────────────

@app.route("/api/income", methods=["GET"])
def get_income():
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    rows = query(conn,
        "SELECT * FROM income WHERE member=%s ORDER BY date DESC, created_at DESC",
        (member,))
    conn.close()
    return jsonify(safe(rows))


@app.route("/api/income", methods=["POST"])
def add_income():
    member, err = get_member_or_400()
    if err: return err
    data = request.get_json()
    if not data.get("amount") or float(data["amount"]) <= 0:
        return jsonify({"error": "A positive amount is required"}), 400
    if not data.get("date"):
        return jsonify({"error": "Date is required"}), 400

    amount = float(data["amount"])
    conn = get_db()
    new_id = query(conn,
        "INSERT INTO income (member,amount,source,date,note) VALUES (%s,%s,%s,%s,%s)",
        (member, amount, data.get("source",""), data["date"], data.get("note","")),
        fetch="none")
    new_balance = adjust_balance(conn, member, amount)
    conn.commit()
    conn.close()
    return jsonify({"id": new_id, "new_balance": new_balance}), 201


@app.route("/api/income/<int:iid>", methods=["DELETE"])
def delete_income(iid):
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    row = query(conn,
        "SELECT amount FROM income WHERE id=%s AND member=%s",
        (iid, member), fetch="one")
    if row:
        adjust_balance(conn, member, -float(row["amount"]))
    query(conn, "DELETE FROM income WHERE id=%s AND member=%s",
          (iid, member), fetch="none")
    conn.commit()
    nb = get_balance(conn, member)
    conn.close()
    return jsonify({"success": True, "new_balance": nb})

# ─────────────────────────────────────────
# API — EXPORT CSV (member-isolated)
# ─────────────────────────────────────────

@app.route("/api/export/csv")
def export_expenses_csv():
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    where, params = build_expense_filters(request.args)
    rows = query(conn,
        f"SELECT id,title,amount,category,location,reason,datetime "
        f"FROM expenses {where} ORDER BY datetime DESC",
        [member] + params)
    conn.close()

    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["ID","Title","Amount (₹)","Category","Location","Reason","DateTime"])
    for r in rows:
        w.writerow([r["id"], r["title"], float(r["amount"]),
                    r["category"], r.get("location",""),
                    r.get("reason",""), str(r["datetime"])])

    filename = f"{member}_expenses.csv"
    return Response(out.getvalue(), mimetype="text/csv",
        headers={"Content-Disposition": f"attachment;filename={filename}"})


@app.route("/api/export/income-csv")
def export_income_csv():
    member, err = get_member_or_400()
    if err: return err
    conn = get_db()
    where, params = build_income_filters(request.args)
    rows = query(conn,
        f"SELECT id,amount,source,date,note,created_at "
        f"FROM income {where} ORDER BY date DESC",
        [member] + params)
    conn.close()

    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["ID","Amount (₹)","Source","Date","Note","Recorded At"])
    total = 0.0
    for r in rows:
        amt = float(r["amount"])
        total += amt
        w.writerow([r["id"], amt, r.get("source",""),
                    str(r["date"]), r.get("note",""), str(r["created_at"])])
    w.writerow([])
    w.writerow(["","TOTAL","","",f"₹{total:.2f}",f"{len(rows)} records"])

    filename = f"{member}_income.csv"
    return Response(out.getvalue(), mimetype="text/csv",
        headers={"Content-Disposition": f"attachment;filename={filename}"})

# ─────────────────────────────────────────
# BUDGET ALERT HELPER
# ─────────────────────────────────────────

def check_budget_alert(conn, member, category):
    month_start = date.today().replace(day=1).isoformat()
    brow = query(conn,
        "SELECT monthly_limit FROM budgets WHERE member=%s AND category=%s",
        (member, category), fetch="one")
    if not brow: return None
    spent_row = query(conn,
        "SELECT COALESCE(SUM(amount),0) AS t FROM expenses "
        "WHERE member=%s AND category=%s AND DATE(datetime)>=%s",
        (member, category, month_start), fetch="one")
    limit = float(brow["monthly_limit"])
    spent = float(spent_row["t"])
    pct   = (spent / limit * 100) if limit > 0 else 0
    if pct >= 100:
        return {"type":"danger",
                "message":f"⚠️ Budget exceeded for {category}! ₹{spent:.0f}/₹{limit:.0f}",
                "percent":pct}
    elif pct >= 80:
        return {"type":"warning",
                "message":f"🔔 80% budget used for {category}. ₹{spent:.0f}/₹{limit:.0f}",
                "percent":pct}
    return None

# ─────────────────────────────────────────
# RUN
# ─────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    print("🚀 ExpenseIQ Family running at http://localhost:5000")
    app.run(debug=True, port=5000)
