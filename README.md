# ExpenseIQ — Family Edition

Multi-member personal finance tracker. Each family member has a completely
separate dashboard, expenses, income, balance, and CSV exports.

## Stack
- Python Flask · MySQL · HTML/CSS/Vanilla JS

## Folder Structure
```
expenseiq-family/
├── app.py                  ← Flask backend
├── requirements.txt
├── mysql_setup.sql         ← Optional manual DB setup
├── README.md
├── templates/
│   ├── family.html         ← Member selection screen (first page)
│   └── index.html          ← Dashboard (per member)
└── static/
    ├── css/style.css
    └── js/app.js
```

## Setup

### 1. Edit credentials in app.py
```python
DB_CONFIG = {
    "user":     "root",
    "password": "your_password",   # ← change this
    "database": "expenseiq_family",
}
```

### 2. To add/remove family members — edit app.py
```python
MEMBERS = ["Vijay", "Prasanna", "Tharun"]   # ← edit names here
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Run
```bash
python app.py
```

### 5. Open browser
```
http://localhost:5000
```

## How It Works

1. **First page** (`/`) — Family selection screen with animated cards
2. **Click a member card** — Sets session, redirects to their dashboard
3. **Each member's data is 100% isolated** — every DB query filters by `member`
4. **Switch Member** button in sidebar — returns to family selection screen
5. **CSV exports** are named `Vijay_expenses.csv`, `Prasanna_income.csv` etc.

## Member Colors
- Vijay    → Blue  (#5c9eff)
- Prasanna → Green (#4cef88)
- Tharun   → Amber (#f0a500)

To change colors, edit the `MEMBER_COLORS` dict in `app.py`.

## Add a New Member
1. Add their name to `MEMBERS` list in `app.py`
2. Add their color to `MEMBER_COLORS` dict
3. Add card styles to `family.html` (copy an existing `.card-Name` block)
4. Restart the app — their DB rows are auto-created
