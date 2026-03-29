-- 访问统计数据表
CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT,
    page_path TEXT NOT NULL,
    referrer TEXT,
    user_agent TEXT,
    ip_address TEXT,
    view_count INTEGER DEFAULT 1,
    session_id TEXT,
    duration INTEGER DEFAULT 0,
    country TEXT,
    city TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_viewed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 访问来源统计
CREATE TABLE IF NOT EXISTS referral_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    medium TEXT,
    campaign TEXT,
    page_path TEXT,
    count INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, medium, campaign, page_path)
);

-- 页面性能统计
CREATE TABLE IF NOT EXISTS page_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_path TEXT NOT NULL,
    load_time INTEGER,
    dom_content_loaded INTEGER,
    first_paint INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
