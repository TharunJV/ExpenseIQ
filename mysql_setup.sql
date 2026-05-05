-- ExpenseIQ Family Edition — MySQL Setup
-- Run: mysql -u root -p < mysql_setup.sql

CREATE DATABASE IF NOT EXISTS expenseiq_family
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE expenseiq_family;

CREATE TABLE IF NOT EXISTS members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    color VARCHAR(20) DEFAULT '#5c9eff',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    category VARCHAR(100) NOT NULL,
    location VARCHAR(255),
    reason TEXT,
    datetime DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_member (member),
    INDEX idx_member_date (member, datetime)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS budgets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member VARCHAR(100) NOT NULL,
    category VARCHAR(100) NOT NULL,
    monthly_limit DECIMAL(12,2) NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_member_cat (member, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS income (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member VARCHAR(100) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    source VARCHAR(100),
    date DATE NOT NULL,
    note VARCHAR(500),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_member (member)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS balance (
    member VARCHAR(100) PRIMARY KEY,
    total_amount DECIMAL(14,2) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the three family members
INSERT IGNORE INTO members (name, color) VALUES
  ('Vijay',    '#5c9eff'),
  ('Prasanna', '#4cef88'),
  ('Tharun',   '#f0a500');

INSERT IGNORE INTO balance (member, total_amount) VALUES
  ('Vijay',    0),
  ('Prasanna', 0),
  ('Tharun',   0);

SELECT 'ExpenseIQ Family DB ready ✅' AS status;
