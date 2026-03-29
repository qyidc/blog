-- 清空数据库所有表数据，但保留表结构

-- 清空访问统计相关表
DELETE FROM page_views;
DELETE FROM referral_sources;
DELETE FROM page_performance;
DELETE FROM post_views;
DELETE FROM post_views_log;

-- 清空评论表
DELETE FROM comments;

-- 清空图片和附件表
DELETE FROM images;
DELETE FROM post_images;
DELETE FROM attachments;

-- 清空黑名单表
DELETE FROM ip_blacklist;

-- 重置自增ID
VACUUM;