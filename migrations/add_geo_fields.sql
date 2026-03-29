-- 添加地理位置字段到page_views表
ALTER TABLE page_views ADD COLUMN country TEXT;
ALTER TABLE page_views ADD COLUMN city TEXT;