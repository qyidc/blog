# 数据库迁移错误修复指南

## 问题分析

如果在执行数据库迁移时遇到错误，可能是以下原因：

### 常见错误类型

1. **表已存在错误**
   - 错误信息：`table attachments already exists`
   - 解决方案：使用 `CREATE TABLE IF NOT EXISTS` 语法

2. **外键约束错误**
   - 错误信息：`foreign key mismatch`
   - 解决方案：确保引用的表和字段存在

3. **语法错误**
   - 错误信息：`syntax error near ...`
   - 解决方案：检查SQL语法是否正确

## 推荐的迁移方法

### 方法1：使用增量迁移（推荐）

如果数据库已经存在，只添加新表：

```bash
# 执行附件表的增量迁移
wrangler d1 execute cf_blog-db --file=./migrations/add_attachments.sql
```

### 方法2：完全重建数据库（谨慎使用）

如果需要完全重建：

```bash
# 1. 备份现有数据（重要！）
wrangler d1 export cf_blog-db --output=backup.sql

# 2. 删除现有数据库
wrangler d1 delete cf_blog-db

# 3. 创建新数据库
wrangler d1 create cf_blog-db

# 4. 执行完整迁移
wrangler d1 execute cf_blog-db --file=./migrations/init.sql
```

### 方法3：手动执行SQL

如果上述方法都失败，可以手动执行：

```bash
# 进入D1控制台
wrangler d1 execute cf_blog-db --remote

# 然后手动输入SQL命令
```

## 验证迁移是否成功

### 检查表是否创建

```bash
wrangler d1 execute cf_blog-db --command="SELECT name FROM sqlite_master WHERE type='table' AND name='attachments';"
```

预期输出应该包含 `attachments`。

### 检查表结构

```bash
wrangler d1 execute cf_blog-db --command="PRAGMA table_info(attachments);"
```

预期输出应该显示所有字段：
- id
- file_name
- file_path
- file_size
- file_type
- upload_at
- post_id
- download_count
- created_at

### 测试插入数据

```bash
wrangler d1 execute cf_blog-db --command="INSERT INTO attachments (id, file_name, file_path, file_size, file_type, upload_at) VALUES ('test-id', 'test.pdf', 'assets/attachments/test.pdf', 1024, 'application/pdf', datetime('now'));"
```

如果插入成功，说明表结构正确。

## 常见问题解决

### 问题1：权限错误

**错误信息**：`permission denied`

**解决方案**：
```bash
# 检查wrangler配置
wrangler whoami

# 重新登录
npx wrangler login
```

### 问题2：连接超时

**错误信息**：`connection timeout`

**解决方案**：
```bash
# 检查网络连接
ping api.cloudflare.com

# 重试命令，可能需要多次尝试
wrangler d1 execute cf_blog-db --file=./migrations/add_attachments.sql
```

### 问题3：数据库不存在

**错误信息**：`database not found`

**解决方案**：
```bash
# 创建数据库
wrangler d1 create cf_blog-db

# 然后执行迁移
wrangler d1 execute cf_blog-db --file=./migrations/init.sql
```

## 迁移后验证

### 1. 检查所有表

```bash
wrangler d1 execute cf_blog-db --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

应该看到以下表：
- attachments（新增）
- comments
- images
- ip_blacklist
- post_views
- post_views_log
- posts
- settings

### 2. 检查所有索引

```bash
wrangler d1 execute cf_blog-db --command="SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;"
```

应该看到附件相关的索引：
- idx_attachments_post_id
- idx_attachments_upload_at

### 3. 功能测试

1. 启动应用
2. 登录后台
3. 进入"附件管理"页面
4. 上传测试文件
5. 验证文件能够正常下载

## 回滚方案

如果迁移失败且需要回滚：

```bash
# 删除附件表（如果已创建）
wrangler d1 execute cf_blog-db --command="DROP TABLE IF EXISTS attachments;"

# 删除附件索引
wrangler d1 execute cf_blog-db --command="DROP INDEX IF EXISTS idx_attachments_post_id;"
wrangler d1 execute cf_blog-db --command="DROP INDEX IF EXISTS idx_attachments_upload_at;"
```

## 联系支持

如果以上方法都无法解决问题，请提供以下信息：

1. 完整的错误信息
2. 执行的命令
3. wrangler版本：`wrangler --version`
4. Node.js版本：`node --version`
5. 操作系统信息

## 快速修复命令

如果只是想快速修复，执行以下命令序列：

```bash
# 1. 尝试增量迁移
wrangler d1 execute cf_blog-db --file=./migrations/add_attachments.sql

# 2. 如果失败，检查表是否存在
wrangler d1 execute cf_blog-db --command="SELECT name FROM sqlite_master WHERE type='table' AND name='attachments';"

# 3. 如果表不存在，手动创建
wrangler d1 execute cf_blog-db --command="CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, file_size INTEGER NOT NULL, file_type TEXT NOT NULL, upload_at TEXT NOT NULL, post_id TEXT, download_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL);"

# 4. 创建索引
wrangler d1 execute cf_blog-db --command="CREATE INDEX IF NOT EXISTS idx_attachments_post_id ON attachments(post_id);"
wrangler d1 execute cf_blog-db --command="CREATE INDEX IF NOT EXISTS idx_attachments_upload_at ON attachments(upload_at DESC);"
```