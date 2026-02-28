import { Hono, Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { marked } from 'marked';

// --- 1. 类型定义 ---
export interface Env {
  Bindings: {
    DB: D1Database;
    STATIC_PAGES: R2Bucket;
    ASSETS: R2Bucket;
    BLOG_TITLE: string;
    ADMIN_USERNAME?: string; // Secret
    ADMIN_PASSWORD?: string; // Secret
  };
}
interface Post {
  id: string;
  title: string;
  slug: string;
  content: string;
  category: string;
  tags: string;
  published_at: string;
  is_published: boolean;
  feature_image?: string;
}
type CreatePostInput = Omit<Post, 'id' | 'slug' | 'published_at' | 'tags'> & { tags?: string[] };
type UpdatePostInput = Partial<CreatePostInput>;


// --- 2. 认证中间件 ---
const BasicAuth = async (c: Context<Env>, next: Next) => {
  if (c.req.method === 'OPTIONS') {
    return await next();
  }
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Admin Panel"' },
    });
  }
  const [scheme, encoded] = authHeader.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    return new Response('Malformed Authorization header', { status: 400 });
  }
  const [username, password] = atob(encoded).split(':');
  const storedUsername = c.env.ADMIN_USERNAME;
  const storedPassword = c.env.ADMIN_PASSWORD;
  if (username === storedUsername && password === storedPassword) {
    await next();
  } else {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Admin Panel"' },
    });
  }
};


// --- 3. Hono 应用初始化 ---
const app = new Hono<Env>();


// --- 4. 公共路由 (所有人可访问) ---

// 博客主页
app.get('/', async (c) => {
    try {
        const url = new URL(c.req.url);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const pageSize = 5;
        const offset = (page - 1) * pageSize;

        const totalPostsStmt = c.env.DB.prepare("SELECT COUNT(*) as total FROM posts WHERE is_published = true");
        const postsStmt = c.env.DB.prepare(
            "SELECT slug, title, content, category, tags, published_at FROM posts WHERE is_published = true ORDER BY published_at DESC LIMIT ? OFFSET ?"
        ).bind(pageSize, offset);
        const settingsStmt = c.env.DB.prepare("SELECT value FROM settings WHERE key = 'subtitle'");
        
        const [{ total }] = (await totalPostsStmt.all()).results as { total: number }[];
        const posts = (await postsStmt.all()).results as unknown as Post[];
        const subtitleResult = await settingsStmt.first<{ value: string }>();
        const totalPages = Math.ceil(total / pageSize);
        const subtitle = subtitleResult?.value || 'A modern blog built with Cloudflare.';

        const pageHtml = await renderHomePage({ env: c.env, posts, subtitle, currentPage: page, totalPages });
        return c.html(pageHtml);
    } catch (error: any) {
        console.error("处理首页请求时发生错误:", error);
        return c.text("加载首页失败，请查看日志。", 500);
    }
});

// 博客文章详情页
app.get('/blog/:slug', async (c) => {
    const slug = c.req.param('slug');
    try {
        const object = await c.env.STATIC_PAGES.get(slug);
        if (object === null) return c.text('文章未找到', 404);
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        return new Response(object.body, { headers });
    } catch (e: any) {
        return c.text('获取文章失败', 500);
    }
});

// 搜索、分类、标签页
/**
 * 搜索结果页
 * 
 * 此页面用于展示根据搜索关键词查询到的博客文章列表。
 * 它支持分页显示，每页显示5篇文章。
 * 
 * 搜索逻辑：
 * 1. 从标题和内容中搜索关键词。
 * 2. 仅返回已发布的文章。
 * 
 * @param q - 搜索关键词
 * @param page - 分页页码，默认为1
 * 
 * @returns 包含搜索结果的HTML页面
 * @throws 404 - 如果没有找到任何匹配的文章
 */
app.get('/search', async (c) => {
    const url = new URL(c.req.url);
    const query = url.searchParams.get('q') || '';
    if (!query) return c.redirect('/', 302);

    // 在这里我们使用一个简化的分页逻辑，真实项目中可以做得更复杂
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = 5;
    const offset = (page - 1) * pageSize;

    const postsStmt = c.env.DB.prepare(
        "SELECT * FROM posts WHERE (title LIKE ? OR content LIKE ?) AND is_published = true ORDER BY published_at DESC LIMIT ? OFFSET ?"
    ).bind(`%${query}%`, `%${query}%`, pageSize, offset);
    
    const posts = (await postsStmt.all()).results as unknown as Post[];

    const pageHtml = await renderHomePage({
        env: c.env,
        posts,
        subtitle: `关于 "${query}" 的搜索结果`,
        currentPage: 1, // 简化处理，不为搜索结果做完整分页
        totalPages: 1,
        pageTitle: `搜索: ${query}`
    });
    return c.html(pageHtml);
});

// [NEW] 分类归档页
/**
 * 分类归档页
 * 
 * 此页面展示指定分类下的所有已发布博客文章。
 * 支持分页显示，每页显示5篇文章。
 * 
 * @param name - 分类的名称标识符
 * @param page - 分页页码，默认为1
 * 
 * @returns 包含分类文章列表的HTML页面
 * @throws 404 - 如果指定分类不存在
 * @throws 500 - 如果数据库操作失败
 */
app.get('/category/:name', async (c) => {
    const categoryName = c.req.param('name');
    const url = new URL(c.req.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = 5;
    const offset = (page - 1) * pageSize;

    const totalPostsStmt = c.env.DB.prepare("SELECT COUNT(*) as total FROM posts WHERE category = ? AND is_published = true").bind(categoryName);
    const postsStmt = c.env.DB.prepare(
        "SELECT * FROM posts WHERE category = ? AND is_published = true ORDER BY published_at DESC LIMIT ? OFFSET ?"
    ).bind(categoryName, pageSize, offset);
    
    const [{ total }] = (await totalPostsStmt.all()).results as { total: number }[];
    const posts = (await postsStmt.all()).results as unknown as Post[];
    const totalPages = Math.ceil(total / pageSize);

    const pageHtml = await renderHomePage({
        env: c.env,
        posts,
        subtitle: ``,
        currentPage: page,
        totalPages,
        pageTitle: `分类: ${categoryName}`
    });
    return c.html(pageHtml);
});


// [NEW] 标签归档页
/**
 * 标签归档页
 * 
 * 此页面展示指定标签下的所有已发布博客文章。
 * 支持分页显示，每页显示5篇文章。
 * 
 * @param name - 标签的名称标识符
 * @param page - 分页页码，默认为1
 * 
 * @returns 包含标签文章列表的HTML页面
 * @throws 404 - 如果指定标签不存在
 * @throws 500 - 如果数据库操作失败
 */
app.get('/tags/:name', async (c) => {
    const tagName = c.req.param('name');
    const url = new URL(c.req.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = 5;
    const offset = (page - 1) * pageSize;

    // 注意：在 SQLite 中查询 JSON 数组，我们使用 LIKE
    const totalPostsStmt = c.env.DB.prepare(`SELECT COUNT(*) as total FROM posts WHERE tags LIKE ? AND is_published = true`).bind(`%"${tagName}"%`);
    const postsStmt = c.env.DB.prepare(
        `SELECT * FROM posts WHERE tags LIKE ? AND is_published = true ORDER BY published_at DESC LIMIT ? OFFSET ?`
    ).bind(`%"${tagName}"%`, pageSize, offset);

    const [{ total }] = (await totalPostsStmt.all()).results as { total: number }[];
    const posts = (await postsStmt.all()).results as unknown as Post[];
    const totalPages = Math.ceil(total / pageSize);

    const pageHtml = await renderHomePage({
        env: c.env,
        posts,
        subtitle: ``,
        currentPage: page,
        totalPages,
        pageTitle: `标签: ${tagName}`
    });
    return c.html(pageHtml);
});

// 公共静态资源 (如博客主站的 style.css)
app.get('/assets/*', async (c) => {
    const key = c.req.path.substring(1);
    try {
        const object = await c.env.ASSETS.get(key);
        if (object === null) return new Response('Not Found', { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        if (key.endsWith('.css')) headers.set('Content-Type', 'text/css');
        return new Response(object.body, { headers });
    } catch (e) {
        return new Response('Error serving asset', { status: 500 });
    }
});

// 公共 API (如侧边栏数据)
app.get('/api/sidebar-data', async (c) => {
    try {
        const categoriesStmt = c.env.DB.prepare("SELECT category, COUNT(*) as count FROM posts WHERE is_published = true AND category IS NOT NULL GROUP BY category ORDER BY count DESC");
        const tagsStmt = c.env.DB.prepare("SELECT json_each.value as tag, COUNT(*) as count FROM posts, json_each(posts.tags) WHERE is_published = true GROUP BY tag ORDER BY count DESC");
        const linksStmt = c.env.DB.prepare("SELECT name, url FROM links ORDER BY sort_order ASC, id ASC");

        const [categories, tags, links] = await Promise.all([ categoriesStmt.all(), tagsStmt.all(), linksStmt.all() ]);

        return c.json({
            categories: categories.results,
            tags: tags.results,
            links: links.results
        });
    } catch (e: any) {
       return c.json({ error: 'Failed to fetch sidebar data', cause: e.message }, 500);
    }
});


// --- 5. 受保护的路由组 (需要认证) ---
const secure = new Hono<Env>();
secure.use('*', BasicAuth); // 将认证中间件应用到此组的所有路由

// --- 5.1 受保护的后台管理页面 ---
secure.get('/admin/', (c) => c.redirect('/admin', 301));
secure.get('/admin', async (c) => {
    const object = await c.env.ASSETS.get('admin/index.html');
    if (object === null) return c.text('Admin panel not found. Did you upload it to R2?', 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(object.body, { headers });
});
secure.get('/admin/*', async (c) => {
    const key = c.req.path.substring(1);
    try {
        const object = await c.env.ASSETS.get(key);
        if (object === null) return new Response('Not Found', { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        return new Response(object.body, { headers });
    } catch (e) {
        return new Response('Error serving asset', { status: 500 });
    }
});

// --- 5.2 受保护的 API ---
const api = new Hono<Env>();
api.use('*', cors()); // 将 CORS 应用到所有 API 路由

// 在这里定义所有需要认证的 API 端点
// [新增] 系统工具 API：重建所有静态页面
// 分类 API (已补全)
app.get('/api/categories', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT category as name, COUNT(id) as post_count FROM posts WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY post_count DESC").all();
    return c.json(results);
});
app.put('/api/categories/rename', async (c) => {
    const { oldName, newName } = await c.req.json<{ oldName: string, newName: string }>();
    if (!oldName || !newName) return c.json({ error: 'Old and new names are required' }, 400);
    await c.env.DB.prepare("UPDATE posts SET category = ? WHERE category = ?").bind(newName, oldName).run();
    return c.json({ success: true });
});
app.delete('/api/categories/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    await c.env.DB.prepare("UPDATE posts SET category = NULL WHERE category = ?").bind(name).run();
    return c.json({ success: true });
});

// 标签 API (已补全)
app.get('/api/tags', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT value as name, COUNT(*) as post_count FROM posts, json_each(posts.tags) WHERE json_valid(posts.tags) GROUP BY value ORDER BY post_count DESC").all();
    return c.json(results);
});
app.put('/api/tags/rename', async (c) => {
    const { oldName, newName } = await c.req.json<{ oldName: string, newName: string }>();
    if (!oldName || !newName) return c.json({ error: 'Old and new names are required' }, 400);
    const { results } = await c.env.DB.prepare(`SELECT id, tags FROM posts WHERE tags LIKE ?`).bind(`%"${oldName}"%`).all<Post>();
    const updates = results.map(post => {
        const tags: string[] = JSON.parse(post.tags || '[]');
        const index = tags.indexOf(oldName);
        if (index > -1) { tags[index] = newName; }
        return c.env.DB.prepare("UPDATE posts SET tags = ? WHERE id = ?").bind(JSON.stringify(tags), post.id);
    });
    if (updates.length > 0) await c.env.DB.batch(updates);
    return c.json({ success: true });
});
app.delete('/api/tags/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    const { results } = await c.env.DB.prepare(`SELECT id, tags FROM posts WHERE tags LIKE ?`).bind(`%"${name}"%`).all<Post>();
    const updates = results.map(post => {
        const tags: string[] = JSON.parse(post.tags || '[]');
        const updatedTags = tags.filter(t => t !== name);
        return c.env.DB.prepare("UPDATE posts SET tags = ? WHERE id = ?").bind(JSON.stringify(updatedTags), post.id);
    });
    if (updates.length > 0) await c.env.DB.batch(updates);
    return c.json({ success: true });
});

// 系统工具 API (已补全)
app.post('/api/rebuild-all', async (c) => {
    c.executionCtx.waitUntil((async () => {
        console.log("--- [系统任务] 开始完全重建所有静态页面 ---");
        const { results } = await c.env.DB.prepare("SELECT * FROM posts WHERE is_published = true").all<Post>();
        if (results && results.length > 0) {
            console.log(`准备重建 ${results.length} 篇文章...`);
            for (const post of results) {
                if (post.slug) {
                  console.log(`正在重建: ${post.slug}`);
                  try { await generateAndStoreStaticPage(c.env, post); }
                  catch (e) { console.error(`重建文章 ${post.slug} 时失败:`, e); }
                }
            }
        }
        console.log("--- [系统任务] 静态页面重建完成 ---");
    })());
    return c.json({ message: '重建任务已在后台成功启动！' });
});
app.post('/api/rebuild-all', async (c) => {
    // 使用 waitUntil 确保这个耗时操作可以在后台完成，而不会让 API 请求超时
    c.executionCtx.waitUntil((async () => {
        console.log("--- [系统任务] 开始完全重建所有静态页面 ---");
        
        // 1. 从数据库中获取所有已发布的文章
        const { results } = await c.env.DB.prepare(
            "SELECT * FROM posts WHERE is_published = true"
        ).all<Post>();

        if (results && results.length > 0) {
            console.log(`准备重建 ${results.length} 篇文章...`);
            // 2. 循环遍历每一篇文章
            for (const post of results) {
                console.log(`正在重建: ${post.slug}`);
                try {
                    // 3. 为每一篇文章调用页面生成函数
                    await generateAndStoreStaticPage(c.env, post);
                } catch (e) {
                    console.error(`重建文章 ${post.slug} 时失败:`, e);
                }
            }
        }
        
        console.log("--- [系统任务] 静态页面重建完成 ---");
    })());
    
    // 立刻返回一个成功消息，告知用户任务已在后台开始
    return c.json({ 
        message: '重建任务已在后台成功启动！根据文章数量，这可能需要几分钟才能完成。您可以在 Worker 日志中查看进度。' 
    });
});
// [NEW] 获取所有唯一的分类列表及其文章数
api.get('/categories', async (c) => {
    const { results } = await c.env.DB.prepare(
        "SELECT category as name, COUNT(id) as post_count FROM posts WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY post_count DESC"
    ).all();
    return c.json(results);
});

// [NEW] 获取所有唯一的标签列表及其文章数
api.get('/tags', async (c) => {
    // 这个查询比较复杂，它会解开所有文章中的 tags JSON 数组并进行统计
    const { results } = await c.env.DB.prepare(
        "SELECT value as name, COUNT(*) as post_count FROM posts, json_each(posts.tags) GROUP BY value ORDER BY post_count DESC"
    ).all();
    return c.json(results);
});

// --- Settings API ---
api.get('/settings', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM settings").all();
    const settings = results.reduce((acc, curr) => {
        if (typeof curr.key === 'string') {
            (acc as Record<string, any>)[curr.key] = curr.value;
        }
        return acc;
    }, {});
    return c.json(settings);
});

api.put('/settings', async (c) => {
    const body = await c.req.json<Record<string, string>>();
    const stmts = Object.entries(body).map(([key, value]) => 
        c.env.DB.prepare("UPDATE settings SET value = ? WHERE key = ?").bind(value, key)
    );
    await c.env.DB.batch(stmts);
    return c.json({ success: true });
});

// --- Links API ---
api.get('/links', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM links ORDER BY sort_order ASC, id ASC").all();
    return c.json(results);
});

api.post('/links', async (c) => {
    const { name, url } = await c.req.json<{name: string, url: string}>();
    await c.env.DB.prepare("INSERT INTO links (name, url) VALUES (?, ?)").bind(name, url).run();
    return c.json({ success: true }, 201);
});

api.put('/links/:id', async (c) => {
    const id = c.req.param('id');
    const { name, url } = await c.req.json<{name: string, url: string}>();
    await c.env.DB.prepare("UPDATE links SET name = ?, url = ? WHERE id = ?").bind(name, url, id).run();
    return c.json({ success: true });
});

api.delete('/links/:id', async (c) => {
    const id = c.req.param('id');
    await c.env.DB.prepare("DELETE FROM links WHERE id = ?").bind(id).run();
    return c.json({ success: true });
});

// [GET] 获取所有文章
/**
 * 获取文章列表
 * 
 * 此 API 用于获取所有已发布的博客文章列表。
 * 文章按发布时间倒序排序，每页返回5条。
 * 
 * @param page - 分页页码，默认为1
 * 
 * @returns 包含文章列表的 JSON 响应
 * @throws 500 - 如果数据库操作失败
 */
api.get('/posts', async (c) => {
    try {
        const { results } = await c.env.DB.prepare(
            'SELECT id, title, slug, category, tags, published_at, is_published FROM posts ORDER BY published_at DESC'
        ).all<Omit<Post, 'content'>>();
        return c.json(results);
    } catch (e: any) {
        return c.json({ error: 'Failed to fetch posts list', cause: e.message }, 500);
    }
});

// [GET] 获取单篇文章用于编辑
/**
 * 获取单篇文章
 * 
 * 此 API 用于获取指定 ID 的博客文章。
 * 文章的内容不会返回，仅返回元数据。
 * 
 * @param id - 文章的唯一标识符
 * 
 * @returns 包含文章元数据的 JSON 响应
 * @throws 404 - 如果指定 ID 的文章不存在
 * @throws 500 - 如果数据库操作失败
 */
api.get('/posts/:id', async (c) => {
    const id = c.req.param('id');
    try {
        const post = await c.env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<Post>();
        if (!post) return c.json({ error: 'Post not found' }, 404);
        return c.json(post);
    } catch (e: any) {
        return c.json({ error: 'Failed to fetch single post', cause: e.message }, 500);
    }
});

// [POST] 创建新文章
/**
 * 创建新文章
 * 
 * 此 API 用于创建新的博客文章。
 * 文章的标题是生成 slug 的基础，必须存在。
 * 文章的发布时间默认为当前时间。
 * 
 * @param title - 文章的标题，用于生成 slug
 * @param content - 文章的内容，支持 Markdown 格式
 * @param category - 文章的分类，可选
 * @param tags - 文章的标签列表，可选
 * @param is_published - 文章是否已发布，默认 true
 * @param feature_image - 文章的特色图像 URL，可选
 * 
 * @returns 包含新文章 ID 和 slug 的 JSON 响应
 * @throws 400 - 如果标题缺失
 * @throws 500 - 如果数据库操作失败
 */
api.post('/posts', async (c) => {
    try {
        const body = await c.req.json<CreatePostInput>();
        if (!body.title) { // 标题是生成 slug 的基础，必须存在
            return c.json({ error: 'Title is required' }, 400);
        }

        // 1. 在所有数据库操作前，准备好所有数据
        const id = crypto.randomUUID();
        let slug = await generateUniqueSlug(c.env.DB, body.title, id);
        
        // 最终保障：如果 slug 意外为空，使用 ID 作为 slug
        if (!slug) {
            slug = id;
        }

        const featureImage = body.feature_image || '/assets/banner.jpg';
        const publishedAt = new Date().toISOString();

        // 2. 一次性将所有正确数据插入数据库
        await c.env.DB.prepare(
            'INSERT INTO posts (id, title, slug, content, category, tags, feature_image, is_published, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
            id, body.title, slug, body.content || '', body.category || 'Uncategorized',
            JSON.stringify(body.tags || []), featureImage, body.is_published ?? true, publishedAt
        ).run();

        // 3. 使用刚刚生成并已存入数据库的确定性数据，来创建静态页面
        const newPost: Post = {
            id, title: body.title, slug, content: body.content || '', category: body.category,
            tags: JSON.stringify(body.tags || []), feature_image: featureImage,
            is_published: body.is_published ?? true, published_at: publishedAt,
        };

        c.executionCtx.waitUntil((async () => {
            await generateAndStoreStaticPage(c.env, newPost);
            const prevPost = await c.env.DB.prepare("SELECT * FROM posts WHERE is_published = true AND published_at < ? ORDER BY published_at DESC LIMIT 1").bind(publishedAt).first<Post>();
            if (prevPost) {
                await generateAndStoreStaticPage(c.env, prevPost);
            }
        })());
        
        return c.json({ id, slug }, 201);

    } catch (e: any) {
        console.error("创建文章时出错:", e);
        return c.json({ error: 'Failed to create post', cause: e.message }, 500);
    }
});

// 更新文章,同步更新上下篇
api.put('/posts/:id', async (c) => {
    const id = c.req.param('id');
    try {
        // 关键：为了确保数据的一致性，我们先找出所有的邻居
        const originalPost = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Post>();
        if (!originalPost) return c.json({ error: 'Post not found' }, 404);

        const neighborsToUpdate: Set<string> = new Set();
        const [originalPrev, originalNext] = await Promise.all([
             c.env.DB.prepare("SELECT * FROM posts WHERE published_at < ? ORDER BY published_at DESC LIMIT 1").bind(originalPost.published_at).first<Post>(),
             c.env.DB.prepare("SELECT * FROM posts WHERE published_at > ? ORDER BY published_at ASC LIMIT 1").bind(originalPost.published_at).first<Post>()
        ]);
        if(originalPrev) neighborsToUpdate.add(originalPrev.id);
        if(originalNext) neighborsToUpdate.add(originalNext.id);

        const body = await c.req.json<UpdatePostInput>();
        const updates: Record<string, any> = { ...body };
        if (body.title && body.title !== originalPost.title) {
            updates.slug = await generateUniqueSlug(c.env.DB, body.title, id);
        }
        if (body.feature_image === '' || body.feature_image === null) {
            updates.feature_image = '/assets/banner.jpg';
        }
        if (body.tags) {
            updates.tags = JSON.stringify(body.tags);
        }
        const fieldsToUpdate = Object.keys(updates).filter(key => updates[key] !== undefined);
        if (fieldsToUpdate.length > 0) {
             const setClauses = fieldsToUpdate.map(field => `${field} = ?`).join(', ');
             const bindings = fieldsToUpdate.map(field => updates[field]);
             await c.env.DB.prepare(`UPDATE posts SET ${setClauses} WHERE id = ?`).bind(...bindings, id).run();
        }

        // 异步重新生成所有受影响的页面
        c.executionCtx.waitUntil((async () => {
            const updatedPost = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Post>();
            if(!updatedPost) return;

            // 1. 生成当前文章的页面
            await generateAndStoreStaticPage(c.env, updatedPost);
            
            // 2. 重新获取更新后的邻居文章，并将它们的 ID 也加入待更新集合
            const [newPrev, newNext] = await Promise.all([
                 c.env.DB.prepare("SELECT * FROM posts WHERE published_at < ? ORDER BY published_at DESC LIMIT 1").bind(updatedPost.published_at).first<Post>(),
                 c.env.DB.prepare("SELECT * FROM posts WHERE published_at > ? ORDER BY published_at ASC LIMIT 1").bind(updatedPost.published_at).first<Post>()
            ]);
            if(newPrev) neighborsToUpdate.add(newPrev.id);
            if(newNext) neighborsToUpdate.add(newNext.id);

            // 3. 循环重新生成所有邻居文章的页面
            for(const postId of neighborsToUpdate) {
                if (postId !== id) { // 避免重复生成当前文章
                    const neighborPost = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).first<Post>();
                    if (neighborPost) await generateAndStoreStaticPage(c.env, neighborPost);
                }
            }
        })());

        return c.json({ message: 'Post updated successfully' });
    } catch (e: any) {
        console.error(`更新文章 ${id} 时出错:`, e);
        return c.json({ error: 'Failed to update post', cause: e.message }, 500);
    }
});

// [DELETE] 删除文章,带邻居更新逻辑
/**
 * 删除文章 * 
 * 此操作会删除指定 ID 的文章，并且会触发其邻居文章的页面重新生成。
 * 具体来说，它会：
 * 1. 从数据库中删除文章记录。
 * 2. 从 R2 中删除文章的静态页面（如果存在）。
 * 3. 重新生成被删除文章的上一篇和下一篇文章的静态页面（如果存在）。 * 
 * @param id - 要删除的文章 ID 
 * @returns 删除成功的消息 
 * @throws 404 - 如果指定 ID 的文章不存在
 * @throws 500 - 如果删除过程中发生未知错误
 */
api.delete('/posts/:id', async (c) => {
    const id = c.req.param('id');
    try {
        // 1. 删除前：先找到这篇文章本身，我们需要它的 slug 和发布日期
        const postToDelete = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Post>();
        if (!postToDelete) {
            return c.json({ error: 'Post not found' }, 404);
        }

        // 2. 删除前：根据它的发布日期，找到它的邻居
        const [prevPost, nextPost] = await Promise.all([
            c.env.DB.prepare("SELECT * FROM posts WHERE is_published = true AND published_at < ? ORDER BY published_at DESC LIMIT 1").bind(postToDelete.published_at).first<Post>(),
            c.env.DB.prepare("SELECT * FROM posts WHERE is_published = true AND published_at > ? ORDER BY published_at ASC LIMIT 1").bind(postToDelete.published_at).first<Post>()
        ]);

        // 3. 执行删除操作
        await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
        
        // 4. 异步执行清理和更新任务
        c.executionCtx.waitUntil((async () => {
            console.log(`[删除任务] 开始处理文章 ${id} 的删除后续...`);
            
            // 4.1 删除它自己的静态页面
            if (postToDelete.slug) {
                await c.env.STATIC_PAGES.delete(postToDelete.slug);
                console.log(`[删除任务] 已删除 R2 页面: ${postToDelete.slug}`);
            }

            // 4.2 如果存在上一篇文章，则重新生成它的页面
            if (prevPost) {
                console.log(`[删除任务] 找到上一篇文章 ${prevPost.id}，为其重新生成页面...`);
                await generateAndStoreStaticPage(c.env, prevPost);
            }

            // 4.3 如果存在下一篇文章，则重新生成它的页面
            if (nextPost) {
                console.log(`[删除任务] 找到下一篇文章 ${nextPost.id}，为其重新生成页面...`);
                await generateAndStoreStaticPage(c.env, nextPost);
            }
            console.log(`[删除任务] 文章 ${id} 的删除后续处理完毕。`);
        })());

        return c.json({ message: 'Post deleted successfully. Neighbor pages are being updated.' });

    } catch (e: any) {
        console.error(`删除文章 ${id} 时出错:`, e);
        return c.json({ error: 'Failed to delete post', cause: e.message }, 500);
    }
});

// 将受保护的 API 挂载到受保护的组中
secure.route('/api', api);

// --- 6. 将受保护的路由组挂载到主应用上 ---
app.route('/', secure);


// --- 7. 辅助函数 (无需改动) ---
// 生成唯一的 slug
/**
 * 生成唯一的 slug
 * 
 * 此函数根据文章标题生成一个唯一的 slug，用于 URL 标识符。
 * 如果生成的 slug 已存在于数据库中，会自动添加后缀（如-1、-2等）以确保其唯一性。
 * 
 * @param db - D1 数据库实例，用于检查 slug 冲突
 * @param title - 文章的标题
 * @param postId - 文章的 ID（可选，用于备用方案）
 * 
 * @returns 生成的唯一 slug
 * @throws 500 - 如果在数据库操作过程中发生错误
 */
async function generateUniqueSlug(db: D1Database, title: string, postId: string): Promise<string> {
    // 1. 将标题转换为 slug 格式，允许中文字符通过 encodeURIComponent 转码
    let baseSlug = title.toLowerCase()
        .trim()
        .replace(/\s+/g, '-') // 空格替换为 -
        .replace(/[^\w-.]/g, ''); // 移除大部分非单词字符，但保留 . 和 -

    // 2. 如果处理后 slug 为空，则使用文章 ID 作为备用方案
    if (!baseSlug) {
        baseSlug = postId;
    }

    // 3. 检查 slug 是否已存在，如果存在则添加后缀
    let slug = baseSlug;
    let count = 0;
    while (true) {
        const potentialSlug = count > 0 ? `${baseSlug}-${count}` : baseSlug;
        const existing = await db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?')
            .bind(potentialSlug, postId)
            .first();

        if (!existing) {
            slug = potentialSlug;
            break;
        }
        count++;
    }
    return slug;
}

/**
 * 构建静态页面并存入R2存储桶内
 * 
 * 此函数根据给定的文章数据，生成完整的HTML页面内容，并将其上传至R2存储桶。
 * 页面内容包括文章标题、正文内容、导航链接（上一篇、下一篇、返回首页）、站点副标题等。
 * 
 * @param env - 环境变量绑定，包含存储桶和数据库实例
 * @param post - 文章数据，包含标题、内容、发布时间等
 * 
 * @returns 上传操作的结果，包含成功或失败信息
 * @throws 500 - 如果在页面渲染或存储过程中发生错误
 */
async function generateAndStoreStaticPage(env: Env['Bindings'], post: {
    id: string;
    title: string;
    slug: string;
    content: string;
    category?: string;
    published_at?: string;
    feature_image?: string;
}) {
    // 1. 数据准备
    const bodyHtml = await marked.parse(post.content);
    const publishedAt = post.published_at || new Date().toISOString();

    const [prevPost, nextPost, subtitleResult] = await Promise.all([
        env.DB.prepare("SELECT title, slug FROM posts WHERE is_published = true AND published_at < ? ORDER BY published_at DESC LIMIT 1").bind(publishedAt).first<{ title: string; slug: string }>(),
        env.DB.prepare("SELECT title, slug FROM posts WHERE is_published = true AND published_at > ? ORDER BY published_at ASC LIMIT 1").bind(publishedAt).first<{ title: string; slug: string }>(),
        env.DB.prepare("SELECT value FROM settings WHERE key = 'subtitle'").first<{ value: string }>()
    ]);
    
    const subtitle = subtitleResult?.value || 'A modern blog built with Cloudflare.';
    const effectiveHeroUrl = post.feature_image || 'https://img.800122.xyz/file/1749907534730_banner.jpg';
    


    // 2. 构建各个 HTML 片段
   const navParts = [
        '<footer class="mt-8 pt-6 border-t border-slate-200 grid grid-cols-3 gap-4 items-center">',
        '<div class="text-left">'
    ];
    //构建上下篇
    if (prevPost) {
        navParts.push('<p class="text-sm text-slate-500 mb-1">上一篇</p>');
        // 使用传统的 + 号拼接，避免任何模板字符串问题
        navParts.push('<a href="/blog/' + prevPost.slug + '" class="font-semibold text-sky-600 hover:text-sky-700 transition-colors block truncate">' + prevPost.title + '</a>');
    }
    navParts.push('</div>');

    navParts.push('<div class="text-center"><a href="/" class="px-4 py-2 bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">返回首页</a></div>');
    
    navParts.push('<div class="text-right">');
    if (nextPost) {
        navParts.push('<p class="text-sm text-slate-500 mb-1">下一篇</p>');
        navParts.push('<a href="/blog/' + nextPost.slug + '" class="font-semibold text-sky-600 hover:text-sky-700 transition-colors block truncate">' + nextPost.title + '</a>');
    }
    navParts.push('</div>');
    navParts.push('</footer>');

    const postNavigationHtml = navParts.join('');
    //icon图标
    const ICONS = { 
        folder: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 inline-block text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>`,
        tag: `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 inline-block" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5a.997.997 0 01.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>`,
        link: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 inline-block text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0m-2.828-2.828a2 2 0 012.828 0l3 3a2 2 0 11-2.828 2.828l-3-3a2 2 0 010-2.828z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M4.586 12.586a2 2 0 010-2.828l3-3a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0z" clip-rule="evenodd" /></svg>`
     }; 
     //侧边栏
    const clientScript = `document.addEventListener('DOMContentLoaded', async () => { 
        const ICONS = {
                    folder: \`${ICONS.folder}\`,
                    tag: \`${ICONS.tag}\`,
                    link: \`${ICONS.link}\`
                };

                try {
                    const response = await fetch('/api/sidebar-data');
                    if (!response.ok) throw new Error('Failed to fetch sidebar data');
                    const data = await response.json();
                    
                    const catList = document.getElementById('categories-list');
                    catList.innerHTML = '';
                    if (data.categories && data.categories.length > 0) {
                        data.categories.forEach(c => {
                            const li = document.createElement('li');
                            li.innerHTML = \`<a href="/category/\${c.category}" class="flex items-center text-slate-600 hover:text-sky-600 transition-colors">\${ICONS.folder} \${c.category} <span class="ml-auto text-xs bg-slate-200 text-slate-600 px-2 py-1 rounded-full">\${c.count}</span></a>\`;
                            catList.appendChild(li);
                        });
                    } else { catList.innerHTML = '<li>暂无分类</li>'; }

                    const tagList = document.getElementById('tags-list');
                    tagList.innerHTML = '';
                    if (data.tags && data.tags.length > 0) {
                        data.tags.forEach(t => {
                            const a = document.createElement('a');
                            a.href = \`/tags/\${t.tag}\`;
                            a.className = 'inline-flex items-center bg-slate-100 text-slate-700 px-3 py-1 rounded-full text-sm hover:bg-sky-100 hover:text-sky-800 transition-colors';
                            a.innerHTML = \`\${ICONS.tag} \${t.tag}\`;
                            tagList.appendChild(a);
                        });
                    } else { tagList.innerHTML = '<p>暂无标签</p>'; }

                    const linkList = document.getElementById('links-list');
                    linkList.innerHTML = '';
                    if (data.links && data.links.length > 0) {
                        data.links.forEach(l => {
                            const li = document.createElement('li');
                            li.innerHTML = \`<a href="\${l.url}" target="_blank" rel="noopener noreferrer" class="flex items-center text-slate-600 hover:text-sky-600 transition-colors">\${ICONS.link} \${l.name}</a>\`;
                            linkList.appendChild(li);
                        });
                    } else { linkList.innerHTML = '<li>暂无链接</li>'; }

                } catch (error) { console.error('Failed to load sidebar data:', error); }    
    });`; 

    // 3. 使用数组拼接来构建最终的、安全的 HTML
    const htmlParts = [
        '<!DOCTYPE html>',
        '<html lang="zh-CN" class="scroll-smooth">',
        '<head>',
        '<meta charset="UTF-8">',
        '<meta name="google-site-verification" content="fy8f3pZqV8ZImBK9RczHwy5FXOgKzJ5C-mg8Twzre6E">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',       
        `<title>${post.title} - ${env.BLOG_TITLE}</title>`,
        '<link href="/assets/style.css" rel="stylesheet">',
        '<style>',
            '.post-content h1, .post-content h2, .post-content h3, .post-content h4 { font-weight: 700; margin-top: 2.5rem; margin-bottom: 1.25rem; color: #1e293b; }',
            '.post-content p { margin-bottom: 1.25rem; line-height: 1.75; color: #334155; }',
            '.post-content a { color: #0ea5e9; text-decoration: none; border-bottom: 1px solid #0ea5e9; transition: all 0.2s ease-in-out; }',
            '.post-content a:hover { background-color: #0ea5e9; color: white; border-radius: 3px; }',
            '.post-content ul, .post-content ol { margin-bottom: 1.25rem; padding-left: 1.5rem; }',
            '.post-content li { margin-bottom: 0.5rem; }',
            '.post-content img { max-width: 100%; height: auto; border-radius: 0.75rem; margin-top: 2rem; margin-bottom: 2rem; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1); }',
            '.post-content pre { padding: 1em; background-color: #f1f5f9; border-radius: 0.5rem; overflow-x: auto; margin-bottom: 1.5rem; }',
            '.post-content code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }',
            '.post-content blockquote { border-left: 4px solid #e2e8f0; padding-left: 1rem; color: #64748b; font-style: italic; margin-bottom: 1.25rem; }',
        '</style>',
        '</head>',
        '<body class="bg-slate-100 text-slate-800 font-sans">',
        '<div class="max-w-7xl mx-auto">',
            `<header class="relative flex items-center justify-center text-center min-h-[10vh] md:min-h-[30vh] rounded-b-lg shadow-lg" style="background-image: url('${effectiveHeroUrl}'); background-repeat: no-repeat; background-size: contain; background-attachment: fixed;">`,
                '<div class="absolute inset-0 bg-black opacity-50 rounded-b-lg"></div>',
                '<div class="relative z-10 px-4">',
                    `<h1 class="text-4xl font-extrabold tracking-tight text-white drop-shadow-lg"><a href="/" class="text-white hover:text-white">${env.BLOG_TITLE}</a></h1>`,
                    `<p class="mt-4 text-7xl text-slate-200 drop-shadow-lg">${subtitle}</p>`,
                '</div>',
            '</header>',
            '<br>',        
            '<div class="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-16">',
                '<div class="grid grid-cols-1 lg:grid-cols-4 gap-8 pt-8">',
                    '<main class="lg:col-span-3">',
                        '<article class="bg-white p-6 sm:p-8 rounded-xl shadow-lg">',
                            '<header class="mb-8 text-center border-b pb-6">',
                                `<h1 class="text-6xl font-extrabold text-slate-900 tracking-tight">${post.title}</h1>`,
                                '<p class="mt-4 text-md text-slate-500">',
                                    `<span>发布于: ${new Date(publishedAt).toLocaleDateString()}</span>`,
                                    post.category ? `<span> | 分类: <a class="text-slate-600 hover:text-sky-600" href="/category/${post.category}">${post.category}</a></span>` : '',
                                '</p>',
                            '</header>',
                            '<div class="post-content max-w-none">',
                                bodyHtml, // 将文章正文作为独立部分推入
                            '</div>',
                                postNavigationHtml, // 将导航作为独立部分推入
                        '</article>',
                    '</main>',
                    '<aside class="sidebar space-y-8 lg:sticky top-4">',
                             '<div class="bg-white p-5 rounded-lg shadow-md">',
                                 '<h3 id="search-widget-title" class="font-bold text-lg mb-4 border-b pb-2">站内搜索</h3>',
                                    '<form action="/search" method="get">',
                                    '<input type="search" name="q" placeholder="搜索文章..." class="w-full border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500">',
                                    '<button type="submit" class="ml-2 text-sky-500 hover:underline">搜索</button>',
                                    '</form>',
                                    '</div>',
                                    '<div id="categories-widget" class="bg-white p-5 rounded-lg shadow-md">',
                                    '<h3 id="categories-widget-title" class="font-bold text-lg mb-4 border-b pb-2">分类</h3>',
                                    '<ul id="categories-list" class="space-y-2"><li>加载中...</li></ul>',
                                    '</div>',
                                    '<div id="tags-widget" class="bg-white p-5 rounded-lg shadow-md">',
                                    '<h3 id="tags-widget-title" class="font-bold text-lg mb-4 border-b pb-2">标签</h3>',
                                    '<div id="tags-list" class="flex flex-wrap gap-2">加载中...</div>',
                                    '</div>',
                            '<div id="links-widget" class="bg-white p-5 rounded-lg shadow-md">',
                            '<h3 id="links-widget-title" class="font-bold text-lg mb-4 border-b pb-2">友情链接</h3>',
                            '<ul id="links-list" class="space-y-2"><li>加载中...</li></ul>',
                            '</div>',
                            '</aside>',
                        '</div>',   
            '</div>',
        '</div>',
        '<footer class="text-center py-8 text-slate-500 mt-8">',
            `<p>&copy; ${new Date().getFullYear()} ${env.BLOG_TITLE}. 访问我的<a href="https://github.com/qyidc" class="text-sky-500 hover:underline">Github</a></p>`,
        '</footer>',
        '<script>',
            clientScript, // 将脚本作为独立部分推入
        '</script>',
        '</body>',
        '</html>'
    ];
    
    // 使用 join('') 生成最终的、安全的 HTML 字符串
    const finalHtml = htmlParts.join('');

    // 4. 将最终生成的 HTML 页面存入 R2 存储桶
    await env.STATIC_PAGES.put(post.slug, finalHtml, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
}

/**
 * 渲染首页 HTML 的模板函数
 * 
 * 此函数根据给定的数据，生成完整的博客首页HTML内容。
 * 内容包括文章列表、分页导航、站点标题、副标题、自定义背景图等。
 * 
 * @param data - 包含渲染所需数据的对象
 * @param data.env - 环境变量绑定，包含存储桶和数据库实例
 * @param data.posts - 文章列表，用于显示在首页
 * @param data.subtitle - 站点副标题，用于描述博客主题
 * @param data.currentPage - 当前分页页码
 * @param data.totalPages - 总分页页数
 * @param data.pageTitle - 用于归档页和搜索结果页的自定义标题（可选）
 * @param data.heroImageUrl - 自定义背景图URL（可选）
 * 
 * @returns 渲染后的首页HTML字符串
 */
async function renderHomePage(data: {
    env: Env['Bindings'],
    posts: Post[],
    subtitle: string,
    currentPage: number,
    totalPages: number,
    pageTitle?: string, // 用于归档页和搜索结果页的自定义标题
    heroImageUrl?: string // 自定义背景图URL
}) {
    const { env, posts, subtitle, currentPage, totalPages, pageTitle, heroImageUrl } = data;
    const effectiveHeroUrl = true ? '/assets/banner.jpg' : 'https://img.800122.xyz/file/1749907534730_banner.jpg'; // 如果没有提供自定义图片，则使用默认图

    // 图标 SVG 代码
    const ICONS = {
        folder: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 inline-block text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>`,
        tag: `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 inline-block" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5a.997.997 0 01.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>`,
        link: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 inline-block text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0m-2.828-2.828a2 2 0 012.828 0l3 3a2 2 0 11-2.828 2.828l-3-3a2 2 0 010-2.828z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M4.586 12.586a2 2 0 010-2.828l3-3a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0z" clip-rule="evenodd" /></svg>`
    };

    // 生成文章列表的 HTML
    const postsHtml = posts.length > 0 ? posts.map(post => {
        const excerpt = post.content.replace(/<[^>]*>?/gm, '').substring(0, 150) + '...'; // 移除HTML标签后生成纯文本摘要
        return `
        <article class="bg-white p-6 rounded-lg shadow-md hover:shadow-xl transition-shadow duration-300 ease-in-out">
            <h2 class="text-2xl font-bold mb-2">
                <a href="/blog/${post.slug}" class="text-slate-900 hover:text-sky-600 transition-colors duration-300">${post.title}</a>
            </h2>
            <div class="text-sm text-slate-500 mb-4 flex items-center space-x-4">
                <span class="flex items-center">${ICONS.folder} ${post.category || '未分类'}</span>
                <span>发布于: ${new Date(post.published_at).toLocaleDateString()}</span>
            </div>
            <p class="text-slate-600 mb-4 leading-relaxed">${excerpt}</p>
            <a href="/blog/${post.slug}" class="inline-block bg-sky-500 text-white font-semibold px-4 py-2 rounded-lg hover:bg-sky-600 transition-transform duration-300 hover:scale-105">阅读全文 →</a>
        </article>`;
    }).join('') : "<div class='bg-white p-6 rounded-lg shadow-md'><p>此分类下暂时还没有文章。</p></div>";

    // 生成分页的 HTML
    let paginationHtml = '<nav class="flex justify-center items-center space-x-4 mt-8">';
    if (currentPage > 1) {
        paginationHtml += `<a href="?page=${currentPage - 1}" class="px-4 py-2 bg-white rounded-md shadow-sm text-slate-700 hover:bg-slate-100 transition-colors">‹ 上一页</a>`;
    }
    paginationHtml += `<span class="px-4 py-2 bg-sky-500 text-white font-bold rounded-md shadow-sm">第 ${currentPage} / ${totalPages} 页</span>`;
    if (currentPage < totalPages) {
        paginationHtml += `<a href="?page=${currentPage + 1}" class="px-4 py-2 bg-white rounded-md shadow-sm text-slate-700 hover:bg-slate-100 transition-colors">下一页 ›</a>`;
    }
    paginationHtml += '</nav>';

    // 返回最终的、完整的页面 HTML
    return `
    <!DOCTYPE html>
    <html lang="zh-CN" class="scroll-smooth">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="google-site-verification" content="fy8f3pZqV8ZImBK9RczHwy5FXOgKzJ5C-mg8Twzre6E">
        <title>${pageTitle || env.BLOG_TITLE}</title>
        <link href="/assets/style.css" rel="stylesheet">
    </head>
    <body class="bg-slate-100 text-slate-800 font-sans">
        <div class="max-w-7xl mx-auto">
            <header 
                class="relative flex items-center justify-center text-center min-h-[10vh] md:min-h-[30vh] rounded-b-lg shadow-lg mb-8"
            style="
                background-image: url('${effectiveHeroUrl}');
                background-repeat: no-repeat;
                background-size: contain;
                background-attachment: fixed;
            "
            >
                <div class="absolute inset-0 bg-black opacity-50 rounded-b-lg"></div>
                <div class="relative text-center">
                    <h1 class="text-5xl font-extrabold tracking-tight drop-shadow-md">
                        <a href="/" class="text-white hover:text-white">${pageTitle || env.BLOG_TITLE}</a>
                    </h1>
                    <p class="mt-4 text-xl text-slate-200 drop-shadow-md">${pageTitle ? `共有 ${posts.length} 篇文章` : subtitle}</p>
                </div>
            </header>
            
            <div class="px-4 sm:px-6 lg:px-8">
                <nav class="my-6 bg-white p-3 rounded-lg shadow-md sticky top-2 z-10">
                    <ul class="flex justify-center space-x-2 md:space-x-4">
                        <li><a href="/" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">首页</a></li>
                        <li><a href="/#categories-widget" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">分类</a></li>
                        <li><a href="/#tags-widget" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">标签</a></li>
                        <li><a href="/#links-widget" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">友链</a></li>
                    </ul>
                </nav>

                <div class="grid grid-cols-1 lg:grid-cols-4 gap-8">
                    <main class="lg:col-span-3">
                        <div class="space-y-8">
                        ${postsHtml}
                        </div>
                        ${totalPages > 1 ? paginationHtml : ''}
                    </main>
                    <aside class="sidebar space-y-8">
                        <div class="bg-white p-5 rounded-lg shadow-md">
                            <h3 class="font-bold text-lg mb-4 border-b pb-2">站内搜索</h3>
                            <form action="/search" method="get">
                                <input type="search" name="q" placeholder="搜索文章..." class="w-full border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500">
                            </form>
                        </div>
                        <div id="categories-widget" class="bg-white p-5 rounded-lg shadow-md">
                            <h3 class="font-bold text-lg mb-4 border-b pb-2">分类</h3>
                            <ul id="categories-list" class="space-y-2"><li>加载中...</li></ul>
                        </div>
                        <div id="tags-widget" class="bg-white p-5 rounded-lg shadow-md">
                            <h3 class="font-bold text-lg mb-4 border-b pb-2">标签</h3>
                            <div id="tags-list" class="flex flex-wrap gap-2">加载中...</div>
                        </div>
                        <div id="links-widget" class="bg-white p-5 rounded-lg shadow-md">
                            <h3 class="font-bold text-lg mb-4 border-b pb-2">友情链接</h3>
                            <ul id="links-list" class="space-y-2"><li>加载中...</li></ul>
                        </div>
                    </aside>
                </div>
            </div>
            <footer class="text-center py-8 text-slate-500 mt-8">
                <p>&copy; ${new Date().getFullYear()} ${env.BLOG_TITLE}. 访问我的<a href="https://github.com/qyidc" class="text-sky-500 hover:underline">Github</a></p>
            </footer>
        </div>
        
        <script>
            document.addEventListener('DOMContentLoaded', async () => {
                const ICONS = {
                    folder: \`${ICONS.folder}\`,
                    tag: \`${ICONS.tag}\`,
                    link: \`${ICONS.link}\`
                };

                try {
                    const response = await fetch('/api/sidebar-data');
                    if (!response.ok) throw new Error('Failed to fetch sidebar data');
                    const data = await response.json();
                    
                    const catList = document.getElementById('categories-list');
                    catList.innerHTML = '';
                    if (data.categories && data.categories.length > 0) {
                        data.categories.forEach(c => {
                            const li = document.createElement('li');
                            li.innerHTML = \`<a href="/category/\${c.category}" class="flex items-center text-slate-600 hover:text-sky-600 transition-colors">\${ICONS.folder} \${c.category} <span class="ml-auto text-xs bg-slate-200 text-slate-600 px-2 py-1 rounded-full">\${c.count}</span></a>\`;
                            catList.appendChild(li);
                        });
                    } else { catList.innerHTML = '<li>暂无分类</li>'; }

                    const tagList = document.getElementById('tags-list');
                    tagList.innerHTML = '';
                    if (data.tags && data.tags.length > 0) {
                        data.tags.forEach(t => {
                            const a = document.createElement('a');
                            a.href = \`/tags/\${t.tag}\`;
                            a.className = 'inline-flex items-center bg-slate-100 text-slate-700 px-3 py-1 rounded-full text-sm hover:bg-sky-100 hover:text-sky-800 transition-colors';
                            a.innerHTML = \`\${ICONS.tag} \${t.tag}\`;
                            tagList.appendChild(a);
                        });
                    } else { tagList.innerHTML = '<p>暂无标签</p>'; }

                    const linkList = document.getElementById('links-list');
                    linkList.innerHTML = '';
                    if (data.links && data.links.length > 0) {
                        data.links.forEach(l => {
                            const li = document.createElement('li');
                            li.innerHTML = \`<a href="\${l.url}" target="_blank" rel="noopener noreferrer" class="flex items-center text-slate-600 hover:text-sky-600 transition-colors">\${ICONS.link} \${l.name}</a>\`;
                            linkList.appendChild(li);
                        });
                    } else { linkList.innerHTML = '<li>暂无链接</li>'; }

                } catch (error) { console.error('Failed to load sidebar data:', error); }
            });
        </script>
    </body>
    </html>`;
}

//加载css
app.get('/assets/*', async (c) => {
    // 移除开头的 / 得到 R2 的对象键
    // 例如: c.req.path = /assets/style.css -> key = assets/style.css
    const key = c.req.path.substring(1); 
    console.log(`Attempting to fetch asset from R2 with key: ${key}`);

    try {
        const object = await c.env.ASSETS.get(key);

        if (object === null) {
            console.error(`Asset not found in R2: ${key}`);
            return new Response('Not Found', { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        // 重要：为 CSS 文件设置正确的 Content-Type
        if (key.endsWith('.css')) {
            headers.set('Content-Type', 'text/css');
        }

        return new Response(object.body, { headers });

    } catch (e) {
        console.error(`Error fetching asset from R2: ${key}`, e);
        return new Response('Error serving asset', { status: 500 });
    }
});

// --- 8. 默认导出 ---
export default app;