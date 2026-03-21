-- 附件功能增量迁移脚本
-- 只添加attachments表和相关索引
-- 执行命令: wrangler d1 execute cf_blog-db --file=./migrations/add_attachments.sql

-- 检查并创建附件管理表
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL,
    file_type TEXT NOT NULL,
    upload_at TEXT NOT NULL,
    post_id TEXT,
    download_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL
);

-- 创建附件相关索引
CREATE INDEX IF NOT EXISTS idx_attachments_post_id ON attachments(post_id);
CREATE INDEX IF NOT EXISTS idx_attachments_upload_at ON attachments(upload_at DESC);

-- 验证表是否创建成功
-- 这个查询会返回表的信息
SELECT name FROM sqlite_master WHERE type='table' AND name='attachments';