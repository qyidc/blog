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
type CreatePostInput = Omit<Post, 'id' | 'slug' | 'published_at' | 'tags'> & { tags?: string[], is_draft?: number, is_pinned?: number };
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
  try {
    const decoded = atob(encoded);
    const [username, password] = decoded.split(':');
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
  } catch (e) {
    return new Response('Invalid Authorization header', { status: 400 });
  }
};


// --- 3. 工具函数 ---// 格式化文件大小
function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}


// --- 4. Hono 应用初始化 ---
const app = new Hono<Env>();


// --- 4. 公共路由 (所有人可访问) ---

// 站点地图 sitemap.xml
app.get('/sitemap.xml', async (c) => {
    const { results: posts } = await c.env.DB.prepare(
        "SELECT slug, published_at FROM posts WHERE is_published = 1 AND is_draft = 0"
    ).all<{ slug: string, published_at: string }>();

    // 从设置表读取域名
    const siteUrlResult = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'site_url'").first<{ value: string }>();
    const baseUrl = siteUrlResult?.value || "https://blog.otwx.top";
    
    // XML转义函数
    const escapeXml = (str: string) => {
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&apos;');
    };

    let urls = [
        { 
            loc: escapeXml(`${baseUrl}/`), 
            lastmod: new Date().toISOString(),
            changefreq: 'daily',
            priority: 1.0 
        }
    ];

    posts.forEach(post => {
        const lastmod = post.published_at ? new Date(post.published_at) : null;
        urls.push({
            loc: escapeXml(`${baseUrl}/blog/${post.slug}`),
            lastmod: lastmod ? lastmod.toISOString() : new Date().toISOString(),
            changefreq: 'weekly',
            priority: 0.7
        });
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority.toFixed(1)}</priority>
  </url>
`).join('')}</urlset>`;

    return new Response(xml, {
        headers: { 
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=86400'
        }
    });
});
// robots.txt
app.get('/robots.txt', async (c) => {
    // 从设置表读取域名
    const siteUrlResult = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'site_url'").first<{ value: string }>();
    const baseUrl = siteUrlResult?.value || "https://blog.otwx.top";
    const robotsTxt = `User-agent: *
Allow: /
Sitemap: ${baseUrl}/sitemap.xml

# As a condition of accessing this website, you agree to abide by the following
# content signals:

# (a)  If a content-signal = yes, you may collect content for the corresponding
#      use.
# (b)  If a content-signal = no, you may not collect content for the
#      corresponding use.
# (c)  If the website operator does not include a content signal for a
#      corresponding use, the website operator neither grants nor restricts
#      permission via content signal with respect to the corresponding use.

# The content signals and their meanings are:

# search:   building a search index and providing search results (e.g., returning
#           hyperlinks and short excerpts from your website's contents). Search does not
#           include providing AI-generated search summaries.
# ai-input: inputting content into one or more AI models (e.g., retrieval
#           augmented generation, grounding, or other real-time taking of content for
#           generative AI search answers).
# ai-train: training or fine-tuning AI models.

# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF
# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT
# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.
`;

    return new Response(robotsTxt, {
        headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'public, max-age=86400'
        }
    });
});

// RSS 2.0 Feed
app.get('/feed.xml', async (c) => {
    try {
        // 从设置表读取站点信息
        const [siteUrlResult, blogTitleResult, subtitleResult] = await Promise.all([
            c.env.DB.prepare("SELECT value FROM settings WHERE key = 'site_url'").first<{ value: string }>(),
            c.env.DB.prepare("SELECT value FROM settings WHERE key = 'blog_title'").first<{ value: string }>(),
            c.env.DB.prepare("SELECT value FROM settings WHERE key = 'subtitle'").first<{ value: string }>()
        ]);
        
        const baseUrl = siteUrlResult?.value || "https://blog.otwx.top";
        const blogTitle = blogTitleResult?.value || c.env.BLOG_TITLE || "我的博客";
        const subtitle = subtitleResult?.value || "A modern blog built with Cloudflare.";

        // 查询最新20篇已发布文章
        const { results: posts } = await c.env.DB.prepare(`
            SELECT id, title, slug, content, published_at 
            FROM posts 
            WHERE is_published = 1 AND is_draft = 0 
            ORDER BY published_at DESC 
            LIMIT 20
        `).all<{ id: string, title: string, slug: string, content: string, published_at: string }>();

        // XML转义函数
        const escapeXml = (str: string) => {
            return str.replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;')
                      .replace(/'/g, '&apos;');
        };

        // 生成RSS XML
        const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
    <title>${escapeXml(blogTitle)}</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>${escapeXml(subtitle)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(baseUrl)}/feed.xml" rel="self" type="application/rss+xml" />
    ${posts.map(post => {
        const postUrl = `${baseUrl}/blog/${post.slug}`;
        // 生成摘要，去掉HTML标签，截取前200字
        const excerpt = post.content.replace(/<[^>]*>/g, '').substring(0, 200) + '...';
        return `
    <item>
        <title>${escapeXml(post.title)}</title>
        <link>${escapeXml(postUrl)}</link>
        <guid>${escapeXml(postUrl)}</guid>
        <pubDate>${new Date(post.published_at).toUTCString()}</pubDate>
        <description>${escapeXml(excerpt)}</description>
    </item>`;
    }).join('')}
</channel>
</rss>`;

        return new Response(rssXml, {
            headers: { 
                'Content-Type': 'application/rss+xml; charset=utf-8',
                'Cache-Control': 'public, max-age=3600'
            }
        });
    } catch (e: any) {
        console.error('生成RSS失败:', e);
        return c.text('生成RSS失败', 500);
    }
});

// 文章归档页面
app.get('/archive', async (c) => {
    try {
        // 查询所有已发布文章，按发布时间倒序
        const { results: posts } = await c.env.DB.prepare(`
            SELECT title, slug, published_at 
            FROM posts 
            WHERE is_published = 1 AND is_draft = 0 
            ORDER BY published_at DESC
        `).all<{ title: string, slug: string, published_at: string }>();

        // 按年月分组
        const groupedPosts: Record<string, typeof posts> = {};
        posts.forEach(post => {
            const date = new Date(post.published_at);
            const yearMonth = `${date.getFullYear()}年${date.getMonth() + 1}月`;
            if (!groupedPosts[yearMonth]) {
                groupedPosts[yearMonth] = [];
            }
            groupedPosts[yearMonth].push(post);
        });

        // 生成归档HTML
        const archiveHtml = Object.keys(groupedPosts).sort((a, b) => b.localeCompare(a)).map(yearMonth => `
            <div class="mb-8">
                <h3 class="text-xl font-bold mb-4 text-slate-800 border-b pb-2">${yearMonth} (${groupedPosts[yearMonth].length}篇)</h3>
                <ul class="space-y-2">
                    ${groupedPosts[yearMonth].map(post => `
                        <li class="flex items-center justify-between">
                            <a href="/blog/${post.slug}" class="text-slate-700 hover:text-sky-600 transition-colors">${post.title}</a>
                            <span class="text-sm text-slate-500">${new Date(post.published_at).getDate()}日</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `).join('');

        // 获取站点信息
        const [subtitleResult, blogTitleResult] = await Promise.all([
            c.env.DB.prepare("SELECT value FROM settings WHERE key = 'subtitle'").first<{ value: string }>(),
            c.env.DB.prepare("SELECT value FROM settings WHERE key = 'blog_title'").first<{ value: string }>()
        ]);
        
        const subtitle = subtitleResult?.value || 'A modern blog built with Cloudflare.';
        const blogTitle = blogTitleResult?.value || c.env.BLOG_TITLE || '我的博客';

        // 生成完整页面
        const pageHtml = `
        <!DOCTYPE html>
        <html lang="zh-CN" class="scroll-smooth">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta name="google-site-verification" content="fy8f3pZqV8ZImBK9RczHwy5FXOgKzJ5C-mg8Twzre6E">
            <title>文章归档 - ${blogTitle}</title>
            <link href="/assets/style.css" rel="stylesheet">
        </head>
        <body class="bg-slate-50 min-h-screen">
            <div class="container mx-auto px-4 py-8 max-w-4xl">
                <!-- 头部横幅 -->
                <div class="relative h-64 rounded-lg overflow-hidden mb-8 bg-gradient-to-r from-sky-500 to-indigo-600">
                    <div class="absolute inset-0 bg-black opacity-50"></div>
                    <div class="relative z-10 h-full flex flex-col items-center justify-center text-center px-4">
                        <h1 class="text-4xl font-extrabold tracking-tight text-white drop-shadow-lg">
                            <a href="/" class="text-white hover:text-white">${blogTitle}</a>
                        </h1>
                        <p class="mt-4 text-xl text-slate-200 drop-shadow-lg">文章归档</p>
                    </div>
                </div>

                <!-- 导航 -->
                <nav class="flex justify-center mb-8 space-x-6 text-slate-600">
                    <a href="/" class="hover:text-sky-600 transition-colors">首页</a>
                    <a href="/archive" class="text-sky-600 font-semibold">归档</a>
                </nav>

                <!-- 归档内容 -->
                <div class="bg-white rounded-lg shadow-md p-8">
                    ${archiveHtml}
                </div>

                <!-- 页脚 -->
                <footer class="text-center py-8 text-slate-500 mt-8">
                    <p>&copy; ${new Date().getFullYear()} ${blogTitle}. <a href="/sitemap.xml" class="text-sky-500 hover:underline ml-2">站点地图</a> | <a href="/feed.xml" class="text-sky-500 hover:underline ml-2">RSS订阅</a></p>
                </footer>
            </div>
        </body>
        </html>`;

        return c.html(pageHtml);
    } catch (error: any) {
        console.error("加载归档页面失败:", error);
        return c.text("加载归档页面失败，请查看日志。", 500);
    }
});

// 博客主页
app.get('/', async (c) => {
    try {
        const url = new URL(c.req.url);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const pageSize = 5;
        const offset = (page - 1) * pageSize;

        const totalPostsStmt = c.env.DB.prepare("SELECT COUNT(*) as total FROM posts WHERE is_published = 1 AND is_draft = 0");
        const postsStmt = c.env.DB.prepare(
            "SELECT slug, title, content, category, tags, published_at FROM posts WHERE is_published = 1 AND is_draft = 0 ORDER BY is_pinned DESC, published_at DESC LIMIT ? OFFSET ?"
        ).bind(pageSize, offset);
        const [subtitleResult, blogTitleResult] = await Promise.all([
            c.env.DB.prepare("SELECT value FROM settings WHERE key = 'subtitle'").first<{ value: string }>(),
            c.env.DB.prepare("SELECT value FROM settings WHERE key = 'blog_title'").first<{ value: string }>()
        ]);
        
        const [{ total }] = (await totalPostsStmt.all()).results as { total: number }[];
        const posts = (await postsStmt.all()).results as unknown as Post[];
        const totalPages = Math.ceil(total / pageSize);
        const subtitle = subtitleResult?.value || 'A modern blog built with Cloudflare.';
        const blogTitle = blogTitleResult?.value || c.env.BLOG_TITLE || '我的博客';

        const pageHtml = await renderHomePage({ env: c.env, posts, subtitle, blogTitle, currentPage: page, totalPages });
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
    
    const blogTitleResult = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'blog_title'").first<{ value: string }>();
    const blogTitle = blogTitleResult?.value || c.env.BLOG_TITLE || '我的博客';

    const pageHtml = await renderHomePage({
        env: c.env,
        posts,
        subtitle: `关于 "${query}" 的搜索结果`,
        blogTitle,
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
    
    const blogTitleResult = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'blog_title'").first<{ value: string }>();
    const blogTitle = blogTitleResult?.value || c.env.BLOG_TITLE || '我的博客';

    const pageHtml = await renderHomePage({
        env: c.env,
        posts,
        subtitle: ``,
        blogTitle,
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
    
    const blogTitleResult = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'blog_title'").first<{ value: string }>();
    const blogTitle = blogTitleResult?.value || c.env.BLOG_TITLE || '我的博客';

    const pageHtml = await renderHomePage({
        env: c.env,
        posts,
        subtitle: ``,
        blogTitle,
        currentPage: page,
        totalPages,
        pageTitle: `标签: ${tagName}`
    });
    return c.html(pageHtml);
});

// favicon.ico 路由
app.get('/favicon.ico', async (c) => {
    try {
        const object = await c.env.ASSETS.get('assets/favicon.ico');
        if (object === null) return new Response('Not Found', { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('Content-Type', 'image/x-icon');
        return new Response(object.body, { headers });
    } catch (e) {
        return new Response('Error serving favicon', { status: 500 });
    }
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


// --- 5. 受保护的路由组 (需要认证) ---
const secure = new Hono<Env>();
secure.use('*', BasicAuth); // 将认证中间件应用到此组的所有路由

// --- 5.1 受保护的后台管理页面 ---
secure.get('/', (c) => c.redirect('/admin', 301));
secure.get('', async (c) => {
    try {
        const asset = await c.env.ASSETS.get('admin/index.html');
        if (asset === null) {
            return c.text('Admin panel not found. Did you upload it to R2?', 404);
        }
        const headers = new Headers();
        asset.writeHttpMetadata(headers);
        headers.set('content-type', 'text/html; charset=utf-8');
        return new Response(asset.body, { headers });
    } catch (e) {
        console.error('Error serving admin index:', e);
        return c.text('Error serving admin index', 500);
    }
});
secure.get('/*', async (c) => {
    try {
        const path = c.req.path.substring(1); // 去掉开头的 '/'
        const asset = await c.env.ASSETS.get(`admin/${path}`);
        if (asset === null) {
            return c.text('Not Found', 404);
        }
        const headers = new Headers();
        asset.writeHttpMetadata(headers);
        headers.set('etag', asset.httpEtag);
        return new Response(asset.body, { headers });
    } catch (e) {
        console.error('Error serving admin asset:', e);
        return c.text('Error serving asset', 500);
    }
});

// --- 5.2 受保护的 API ---
const api = new Hono<Env>();
api.use('*', BasicAuth); // 将认证中间件应用到此组的所有路由
api.use('*', cors()); // 将 CORS 应用到所有 API 路由

// 在这里定义所有需要认证的 API 端点
// [新增] 系统统计接口
api.get('/statistics', async (c) => {
    try {
        // 统计各项数据
        const [postCount, publishedPostCount, draftCount, commentCount, pendingCommentCount, totalViews] = await Promise.all([
            // 总文章数
            c.env.DB.prepare("SELECT COUNT(*) as count FROM posts").first<{ count: number }>(),
            // 已发布文章数
            c.env.DB.prepare("SELECT COUNT(*) as count FROM posts WHERE is_published = 1 AND is_draft = 0").first<{ count: number }>(),
            // 草稿数
            c.env.DB.prepare("SELECT COUNT(*) as count FROM posts WHERE is_draft = 1").first<{ count: number }>(),
            // 总评论数
            c.env.DB.prepare("SELECT COUNT(*) as count FROM comments").first<{ count: number }>(),
            // 待审核评论数
            c.env.DB.prepare("SELECT COUNT(*) as count FROM comments WHERE is_approved = 0").first<{ count: number }>(),
            // 总阅读量
            c.env.DB.prepare("SELECT SUM(view_count) as total FROM post_views").first<{ total: number }>()
        ]);

        return c.json({
            success: true,
            data: {
                total_posts: postCount?.count || 0,
                published_posts: publishedPostCount?.count || 0,
                draft_posts: draftCount?.count || 0,
                total_comments: commentCount?.count || 0,
                pending_comments: pendingCommentCount?.count || 0,
                total_views: totalViews?.total || 0
            }
        });
    } catch (e: any) {
        console.error('获取统计数据失败:', e);
        return c.json({ error: '获取统计数据失败' }, 500);
    }
});

// [新增] 系统工具 API：重建所有静态页面
// 分类 API (已补全)
api.get('/categories', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT category as name, COUNT(id) as post_count FROM posts WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY post_count DESC").all();
    return c.json(results);
});
api.put('/categories/rename', async (c) => {
    const { oldName, newName } = await c.req.json<{ oldName: string, newName: string }>();
    if (!oldName || !newName) return c.json({ error: 'Old and new names are required' }, 400);
    await c.env.DB.prepare("UPDATE posts SET category = ? WHERE category = ?").bind(newName, oldName).run();
    return c.json({ success: true });
});
api.delete('/categories/:name', async (c) => {
    const name = c.req.param('name');
    await c.env.DB.prepare("UPDATE posts SET category = '' WHERE category = ?").bind(name).run();
    return c.json({ success: true });
});

// 标签 API (已补全)
api.get('/tags', async (c) => {
    const { results } = await c.env.DB.prepare("SELECT value as name, COUNT(*) as post_count FROM posts, json_each(posts.tags) WHERE json_valid(posts.tags) GROUP BY value ORDER BY post_count DESC").all();
    return c.json(results);
});
api.put('/tags/rename', async (c) => {
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
api.delete('/tags/:name', async (c) => {
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
api.post('/rebuild-all', async (c) => {
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
        const url = new URL(c.req.url);
        const pageParam = url.searchParams.get('page');
        const pageSizeParam = url.searchParams.get('pageSize');
        
        // 向后兼容：如果没有传分页参数，返回原来的数组格式
        if (!pageParam && !pageSizeParam) {
            const { results } = await c.env.DB.prepare(
                'SELECT id, title, slug, category, tags, published_at, is_published, is_draft, is_pinned FROM posts ORDER BY is_pinned DESC, published_at DESC'
            ).all<Omit<Post, 'content'>>();
            return c.json(results);
        }

        // 分页模式
        const page = parseInt(pageParam || '1', 10);
        const pageSize = parseInt(pageSizeParam || '20', 10);
        const offset = (page - 1) * pageSize;
        
        // 获取总数和分页数据
        const [countResult, postsResult] = await Promise.all([
            c.env.DB.prepare('SELECT COUNT(*) as total FROM posts').first<{ total: number }>(),
            c.env.DB.prepare(
                'SELECT id, title, slug, category, tags, published_at, is_published, is_draft, is_pinned FROM posts ORDER BY is_pinned DESC, published_at DESC LIMIT ? OFFSET ?'
            ).bind(pageSize, offset).all<Omit<Post, 'content'>>()
        ]);
        
        const total = countResult?.total || 0;
        const totalPages = Math.ceil(total / pageSize);
        
        return c.json({
            data: postsResult.results,
            pagination: {
                page,
                pageSize,
                total,
                totalPages
            }
        });
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
            'INSERT INTO posts (id, title, slug, content, category, tags, feature_image, is_published, published_at, is_draft, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
            id, body.title, slug, body.content || '', body.category || 'Uncategorized',
            JSON.stringify(body.tags || []), featureImage, body.is_published ?? true, publishedAt,
            body.is_draft ?? 0, body.is_pinned ?? 0
        ).run();

        // 3. 使用刚刚生成并已存入数据库的确定性数据，来创建静态页面
        const newPost: Post = {
            id, title: body.title, slug, content: body.content || '', category: body.category,
            tags: JSON.stringify(body.tags || []), feature_image: featureImage,
            is_published: body.is_published ?? true, published_at: publishedAt,
        };

        // 更新图片关联
        await updatePostImageRelations(c.env.DB, id, body.content || '', body.feature_image);

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

        // 更新图片关联
        const finalContent = body.content !== undefined ? body.content : originalPost.content;
        const finalFeatureImage = body.feature_image !== undefined ? body.feature_image : originalPost.feature_image;
        await updatePostImageRelations(c.env.DB, id, finalContent, finalFeatureImage);

        // 构建更新后的 post 对象用于生成静态页面
        const updatedPost = {
            ...originalPost,
            ...updates,
            tags: updates.tags || originalPost.tags,
            feature_image: updates.feature_image || originalPost.feature_image
        };

        // 异步更新静态页面
        c.executionCtx.waitUntil((async () => {
            // 1. 生成当前文章的静态页面
            await generateAndStoreStaticPage(c.env, updatedPost);
            
            // 2. 找出新的邻居并更新它们的静态页面
            const [newPrev, newNext] = await Promise.all([
                c.env.DB.prepare("SELECT * FROM posts WHERE published_at < ? ORDER BY published_at DESC LIMIT 1").bind(updatedPost.published_at).first<Post>(),
                c.env.DB.prepare("SELECT * FROM posts WHERE published_at > ? ORDER BY published_at ASC LIMIT 1").bind(updatedPost.published_at).first<Post>()
            ]);
            
            if (newPrev && !neighborsToUpdate.has(newPrev.id)) {
                await generateAndStoreStaticPage(c.env, newPrev);
            }
            if (newNext && !neighborsToUpdate.has(newNext.id)) {
                await generateAndStoreStaticPage(c.env, newNext);
            }
            
            // 3. 同时更新旧邻居的静态页面（因为它们的 "下一篇" 或 "上一篇" 可能已经改变）
            for (const neighborId of neighborsToUpdate) {
                const neighborPost = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(neighborId).first<Post>();
                if (neighborPost) {
                    await generateAndStoreStaticPage(c.env, neighborPost);
                }
            }
        })());

        return c.json({ success: true });
    } catch (e: any) {
        console.error("更新文章时出错:", e);
        return c.json({ error: 'Failed to update post', cause: e.message }, 500);
    }
});

// [DELETE] 删除文章
api.delete('/posts/:id', async (c) => {
    const id = c.req.param('id');
    try {
        // 1. 找出要删除的文章
        const postToDelete = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<Post>();
        if (!postToDelete) return c.json({ error: 'Post not found' }, 404);

        // 2. 找出它的邻居，因为它们的上下篇链接需要更新
        const [prevPost, nextPost] = await Promise.all([
            c.env.DB.prepare("SELECT * FROM posts WHERE published_at < ? ORDER BY published_at DESC LIMIT 1").bind(postToDelete.published_at).first<Post>(),
            c.env.DB.prepare("SELECT * FROM posts WHERE published_at > ? ORDER BY published_at ASC LIMIT 1").bind(postToDelete.published_at).first<Post>()
        ]);

        // 3. 执行删除操作
        await c.env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();

        // 4. 从 R2 中删除对应的静态页面
        try {
            await c.env.STATIC_PAGES.delete(postToDelete.slug);
            console.log(`已从 R2 中删除静态页面: ${postToDelete.slug}`);
        } catch (e) {
            console.error(`删除 R2 静态页面时出错:`, e);
        }

        // 5. 重新生成邻居的静态页面，因为它们的上下篇链接现在指向彼此
        c.executionCtx.waitUntil((async () => {
            if (prevPost) {
                console.log(`重新生成上一篇文章的静态页面: ${prevPost.slug}`);
                await generateAndStoreStaticPage(c.env, prevPost);
            }
            if (nextPost) {
                console.log(`重新生成下一篇文章的静态页面: ${nextPost.slug}`);
                await generateAndStoreStaticPage(c.env, nextPost);
            }
        })());

        return c.json({ success: true });
    } catch (e: any) {
        console.error("删除文章时出错:", e);
        return c.json({ error: 'Failed to delete post', cause: e.message }, 500);
    }
});

// 评论管理 API
api.get('/comments', async (c) => {
    const url = new URL(c.req.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    
    const [countResult, commentsResult] = await Promise.all([
        c.env.DB.prepare('SELECT COUNT(*) as total FROM comments').first<{ total: number }>(),
        c.env.DB.prepare(
            'SELECT c.*, p.title as post_title FROM comments c JOIN posts p ON c.post_id = p.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?'
        ).bind(pageSize, offset).all()
    ]);
    
    const total = countResult?.total || 0;
    const totalPages = Math.ceil(total / pageSize);
    
    return c.json({
        data: commentsResult.results,
        pagination: {
            page,
            pageSize,
            total,
            totalPages
        }
    });
});

api.put('/comments/:id', async (c) => {
    const id = c.req.param('id');
    const { is_approved } = await c.req.json<{ is_approved: number }>();
    
    const comment = await c.env.DB.prepare('SELECT post_id FROM comments WHERE id = ?').bind(id).first<{ post_id: string }>();
    if (!comment) return c.json({ error: 'Comment not found' }, 404);
    
    await c.env.DB.prepare('UPDATE comments SET is_approved = ? WHERE id = ?').bind(is_approved, id).run();
    
    // 重新生成对应的文章静态页面
    c.executionCtx.waitUntil((async () => {
        const post = await c.env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(comment.post_id).first<Post>();
        if (post) {
            await generateAndStoreStaticPage(c.env, post);
        }
    })());
    
    return c.json({ success: true });
});

api.delete('/comments/:id', async (c) => {
    const id = c.req.param('id');
    
    const comment = await c.env.DB.prepare('SELECT post_id FROM comments WHERE id = ?').bind(id).first<{ post_id: string }>();
    if (!comment) return c.json({ error: 'Comment not found' }, 404);
    
    await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
    
    // 重新生成对应的文章静态页面
    c.executionCtx.waitUntil((async () => {
        const post = await c.env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(comment.post_id).first<Post>();
        if (post) {
            await generateAndStoreStaticPage(c.env, post);
        }
    })());
    
    return c.json({ success: true });
});

// 图片管理 API
api.get('/images', async (c) => {
    try {
        const url = new URL(c.req.url);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const pageSize = 20;
        const offset = (page - 1) * pageSize;
        
        const [countResult, imagesResult] = await Promise.all([
            c.env.DB.prepare('SELECT COUNT(*) as total FROM images').first<{ total: number }>(),
            c.env.DB.prepare(
                'SELECT * FROM images ORDER BY upload_at DESC LIMIT ? OFFSET ?'
            ).bind(pageSize, offset).all()
        ]);
        
        const total = countResult?.total || 0;
        const totalPages = Math.ceil(total / pageSize);
        
        // 格式化文件大小
        function formatFileSize(bytes: number): string {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        // 添加空值检查
        const images = imagesResult?.results || [];
        
        return c.json({
            data: images.map((img: any) => ({
                ...img,
                url: `https://${c.req.header('host') || 'blog.otwx.top'}/${img.file_path}`,
                file_size_formatted: img.file_size ? formatFileSize(img.file_size) : '0 B'
            })),
            pagination: {
                page,
                pageSize,
                total,
                totalPages
            }
        });
    } catch (e) {
        console.error('获取图片列表失败:', e);
        return c.json({ error: '获取图片列表失败' }, 500);
    }
});

// 图片上传 API
api.post('/upload-image', async (c) => {
    try {
        const formData = await c.req.formData();
        // 同时支持 'file' 和 'image' 字段，以兼容前端代码
        const file = formData.get('file') as File || formData.get('image') as File;
        
        if (!file) {
            return c.json({ error: 'No file provided' }, 400);
        }
        
        // 生成唯一的文件名
        const timestamp = Date.now();
        const randomId = crypto.randomUUID().slice(0, 8);
        const extension = file.name.split('.').pop();
        const fileName = `${timestamp}-${randomId}.${extension}`;
        const filePath = `assets/images/${fileName}`;
        
        // 读取文件内容
        const buffer = await file.arrayBuffer();
        
        // 上传到 R2 (使用与数据库一致的路径)
        await c.env.ASSETS.put(filePath, buffer, {
            httpMetadata: {
                contentType: file.type
            }
        });
        
        // 保存到数据库
        const id = crypto.randomUUID();
        await c.env.DB.prepare(
            'INSERT INTO images (id, file_name, file_path, file_size, file_type, upload_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, file.name, filePath, file.size, file.type, new Date().toISOString()).run();
        
        // 返回图片 URL
        const imageUrl = `https://${c.req.header('host') || 'blog.otwx.top'}/${filePath}`;
        return c.json({ success: true, url: imageUrl });
    } catch (error) {
        console.error('上传图片失败:', error);
        return c.json({ error: '上传失败，请稍后再试' }, 500);
    }
});

api.delete('/images/:id', async (c) => {
    const id = c.req.param('id');
    
    const image = await c.env.DB.prepare('SELECT file_path FROM images WHERE id = ?').bind(id).first<{ file_path: string }>();
    if (!image) return c.json({ error: 'Image not found' }, 404);
    
    await c.env.DB.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
    
    // 从 R2 中删除图片 (使用数据库中保存的完整路径)
    try {
        await c.env.ASSETS.delete(image.file_path);
    } catch (e) {
        console.error('删除图片失败:', e);
    }
    
    return c.json({ success: true });
});

// IP 黑名单管理 API
api.get('/ip-blacklist', async (c) => {
    const url = new URL(c.req.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    
    const [countResult, ipResult] = await Promise.all([
        c.env.DB.prepare('SELECT COUNT(*) as total FROM ip_blacklist').first<{ total: number }>(),
        c.env.DB.prepare(
            'SELECT * FROM ip_blacklist ORDER BY created_at DESC LIMIT ? OFFSET ?'
        ).bind(pageSize, offset).all()
    ]);
    
    const total = countResult?.total || 0;
    const totalPages = Math.ceil(total / pageSize);
    
    return c.json({
        data: ipResult.results,
        pagination: {
            page,
            pageSize,
            total,
            totalPages
        }
    });
});

api.post('/ip-blacklist', async (c) => {
    const { ip_address, reason } = await c.req.json<{ ip_address: string, reason: string }>();
    
    await c.env.DB.prepare('INSERT INTO ip_blacklist (ip_address, reason) VALUES (?, ?)').bind(ip_address, reason).run();
    
    return c.json({ success: true }, 201);
});

api.delete('/ip-blacklist/:id', async (c) => {
    const id = c.req.param('id');
    
    await c.env.DB.prepare('DELETE FROM ip_blacklist WHERE id = ?').bind(id).run();
    
    return c.json({ success: true });
});

// 侧边栏数据 API 路由 (公共API，不需要认证)
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

// 文章阅读次数统计 API 路由 (公共API，不需要认证)
app.get('/api/posts/:postId/views', async (c) => {
    const postId = c.req.param('postId');
    try {
        // 检查文章是否存在
        const post = await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
        if (!post) {
            return c.json({ error: '文章不存在' }, 404);
        }

        // 更新或插入阅读计数
        const now = new Date().toISOString();
        await c.env.DB.prepare(
            'INSERT INTO post_views (post_id, view_count, last_viewed_at) VALUES (?, 1, ?) ON CONFLICT(post_id) DO UPDATE SET view_count = view_count + 1, last_viewed_at = ?'
        ).bind(postId, now, now).run();

        return c.json({ success: true });
    } catch (e: any) {
        console.error('更新阅读数失败:', e);
        return c.json({ error: '更新阅读数失败' }, 500);
    }
});

// 评论提交 API 路由 (公共API，不需要认证)
app.post('/api/posts/:postId/comments', async (c) => {
    const postId = c.req.param('postId');
    try {
        // 获取用户IP
        const userIp = c.req.header('CF-Connecting-IP') || 
                      c.req.header('X-Forwarded-For')?.split(',')[0].trim() || 
                      'unknown';

        // 检查IP是否在黑名单
        if (await isIpBlacklisted(c.env.DB, userIp)) {
            return c.json({ error: '您的IP已被禁止评论' }, 403);
        }

        // 验证文章是否存在
        const post = await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
        if (!post) {
            return c.json({ error: '文章不存在' }, 404);
        }

        const body = await c.req.json();
        const { author, content, email, parent_id, reply_to } = body;

        // 参数验证
        if (!author || !author.trim() || !content || !content.trim()) {
            return c.json({ error: '昵称和评论内容不能为空' }, 400);
        }

        // 如果有parent_id，验证父评论是否存在
        let replyToName = reply_to;
        if (parent_id) {
            const parentComment = await c.env.DB.prepare('SELECT author FROM comments WHERE id = ?').bind(parent_id).first<{ author: string }>();
            if (!parentComment) {
                return c.json({ error: '回复的评论不存在' }, 404);
            }
            replyToName = parentComment.author;
        }

        // 防灌水：同一IP1分钟内最多评论3次
        const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
        const recentComments = await c.env.DB.prepare(`
            SELECT COUNT(*) as count FROM comments 
            WHERE ip_address = ? AND created_at > ?
        `).bind(userIp, oneMinuteAgo).first<{ count: number }>();

        if (recentComments && recentComments.count >= 3) {
            return c.json({ error: '评论太频繁了，请稍后再试' }, 429);
        }

        // 保存评论（默认待审核）
        const commentId = crypto.randomUUID();
        const createdAt = new Date().toISOString();

        await c.env.DB.prepare(`
            INSERT INTO comments (id, post_id, author, email, content, ip_address, created_at, is_approved, parent_id, reply_to)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).bind(
            commentId,
            postId,
            author.trim(),
            email?.trim() || null,
            content.trim(),
            userIp,
            createdAt,
            parent_id || null,
            replyToName || null
        ).run();

        // 异步重新生成文章静态页面
        c.executionCtx.waitUntil((async () => {
            const updatedPost = await c.env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first<Post>();
            if (updatedPost) {
                await generateAndStoreStaticPage(c.env, updatedPost);
            }
        })());

        return c.json({ 
            success: true, 
            message: '评论提交成功！',
            comment: { id: commentId, author: author.trim(), content: content.trim(), created_at: createdAt }
        }, 201);

    } catch (e: any) {
        console.error('提交评论失败:', e);
        return c.json({ error: '提交失败: ' + e.message }, 500);
    }
});

// 注册 API 路由 (需要认证的 API)
app.route('/api', api);

// 注册受保护的路由 (仅 /admin 路径需要认证)
app.route('/admin', secure);

// 定义为 ES 模块
app.fire();
export default app;


// --- 辅助函数 ---

/**
 * 生成唯一的文章 slug
 * 
 * @param db - D1 数据库实例
 * @param title - 文章标题
 * @param excludeId - 排除的文章 ID（用于更新时避免与自己冲突）
 * @returns 唯一的 slug
 */
async function generateUniqueSlug(db: D1Database, title: string, excludeId?: string): Promise<string> {
    // 1. 生成基础 slug
    let slug = title
        .toLowerCase()
        .replace(/[\s\u00A0]+/g, '-')  // 替换空格和不间断空格为连字符
        .replace(/[^a-z0-9\u4e00-\u9fa5-_]/g, '') // 移除非字母数字、中文、连字符和下划线的字符
        .replace(/-{2,}/g, '-')         // 替换连续的连字符为单个连字符
        .replace(/^-|-$/g, '');          // 移除首尾的连字符

    // 2. 确保 slug 不为空
    if (!slug) {
        slug = 'post';
    }

    // 3. 检查并处理重复
    let suffix = 1;
    let baseSlug = slug;
    
    while (true) {
        const query = excludeId 
            ? 'SELECT id FROM posts WHERE slug = ? AND id != ?'
            : 'SELECT id FROM posts WHERE slug = ?';
        const params = excludeId ? [slug, excludeId] : [slug];
        const result = await db.prepare(query).bind(...params).first();
        if (!result) break;
        slug = `${baseSlug}-${suffix++}`;
    }
    return slug;
}

/**
 * 生成并存储静态页面
 * 
 * @param env - 环境变量，包含 DB 和 STATIC_PAGES
 * @param post - 文章对象
 */
async function generateAndStoreStaticPage(env: any, post: Post) {
    // 1. 数据准备
    const bodyHtml = await marked.parse(post.content);
    const publishedAt = post.published_at || new Date().toISOString();

    const [prevPost, nextPost, subtitleResult, blogTitleResult, viewsResult, commentsCountResult, commentsResult] = await Promise.all([
        env.DB.prepare("SELECT title, slug FROM posts WHERE is_published = true AND published_at < ? ORDER BY published_at DESC LIMIT 1").bind(publishedAt).first<{ title: string; slug: string }>(),
        env.DB.prepare("SELECT title, slug FROM posts WHERE is_published = true AND published_at > ? ORDER BY published_at ASC LIMIT 1").bind(publishedAt).first<{ title: string; slug: string }>(),
        env.DB.prepare("SELECT value FROM settings WHERE key = 'subtitle'").first<{ value: string }>(),
        env.DB.prepare("SELECT value FROM settings WHERE key = 'blog_title'").first<{ value: string }>(),
        env.DB.prepare("SELECT view_count FROM post_views WHERE post_id = ?").bind(post.id).first<{ view_count: number }>(),
        env.DB.prepare("SELECT COUNT(*) as count FROM comments WHERE post_id = ? AND is_approved = 1").bind(post.id).first<{ count: number }>(),
        env.DB.prepare("SELECT id, author, content, created_at, parent_id, reply_to FROM comments WHERE post_id = ? AND is_approved = 1 ORDER BY created_at ASC").bind(post.id).all()
    ]);

    // 2. 计算阅读量
    const viewCount = viewsResult?.view_count || 0;

    // 3. 生成评论HTML
    const commentsHtml = commentsResult.results.map((comment: any) => `
        <div class="bg-slate-50 p-4 rounded-lg mb-4">
            <div class="flex justify-between items-center mb-2">
                <strong class="text-slate-900">${comment.author}</strong>
                <span class="text-xs text-slate-500">${new Date(comment.created_at).toLocaleString()}</span>
            </div>
            ${comment.reply_to ? `<p class="text-sm text-slate-500 mb-2">回复 <strong>@${comment.reply_to}</strong></p>` : ''}
            <p class="text-slate-700">${comment.content}</p>
            <div class="mt-2">
                <button class="reply-btn text-xs text-sky-600 hover:underline" data-id="${comment.id}" data-author="${comment.author}">回复</button>
            </div>
        </div>
    `).join('') || '<p class="text-slate-500 text-center">暂无评论</p>';

    // 4. 生成完整HTML
    const ICONS = {
        folder: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 inline-block text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>`,
        tag: `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1 inline-block" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5a.997.997 0 01.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>`,
        link: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 inline-block text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0m-2.828-2.828a2 2 0 012.828 0l3 3a2 2 0 11-2.828 2.828l-3-3a2 2 0 010-2.828z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M4.586 12.586a2 2 0 010-2.828l3-3a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0z" clip-rule="evenodd" /></svg>`
    };

    // 客户端脚本
    const clientScript = `
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

            // 文章阅读次数统计
            const postId = '${post.id}';
            if (postId) {
                try {
                    // 异步更新阅读数，不阻塞页面加载
                    fetch(\`/api/posts/\${postId}/views\`).catch(err => console.error('Failed to update views:', err));
                } catch (e) {
                    console.error('Views update error:', e);
                }
            }

            // 评论表单提交
            const commentForm = document.getElementById('comment-form');
            if (commentForm && postId) {
                commentForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const submitBtn = commentForm.querySelector('button[type="submit"]');
                    const originalText = submitBtn.textContent;
                    submitBtn.textContent = '提交中...';
                    submitBtn.disabled = true;

                    try {
                        const author = document.getElementById('comment-author').value.trim();
                        const email = document.getElementById('comment-email').value.trim();
                        const content = document.getElementById('comment-content').value.trim();
                        const parentId = document.getElementById('comment-parent-id').value.trim();

                        if (!author || !content) {
                            alert('请填写昵称和评论内容！');
                            submitBtn.textContent = originalText;
                            submitBtn.disabled = false;
                            return;
                        }

                        const response = await fetch(\`/api/posts/\${postId}/comments\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ author, email, content, parent_id: parentId || null })
                        });

                        const result = await response.json();
                        if (!response.ok) {
                            throw new Error(result.error || '提交失败，请稍后再试');
                        }

                        alert('评论提交成功！页面将刷新显示您的评论。');
                        window.location.reload();
                    } catch (err) {
                        alert(\`提交失败: \${err.message}\`);
                    } finally {
                        submitBtn.textContent = originalText;
                        submitBtn.disabled = false;
                    }
                });

                // 回复按钮功能
                document.querySelectorAll('.reply-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const commentId = btn.dataset.id;
                        const author = btn.dataset.author;
                        document.getElementById('comment-parent-id').value = commentId;
                        document.getElementById('reply-text').innerHTML = \`正在回复 <strong>@\${author}</strong>\`;
                        document.getElementById('reply-notice').classList.remove('hidden');
                        document.getElementById('comment-form').scrollIntoView({ behavior: 'smooth' });
                        document.getElementById('comment-content').focus();
                    });
                });

                // 取消回复功能
                document.getElementById('cancel-reply').addEventListener('click', () => {
                    document.getElementById('comment-parent-id').value = '';
                    document.getElementById('reply-notice').classList.add('hidden');
                });
            }
        });
    `;

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="zh-CN" class="scroll-smooth">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="google-site-verification" content="fy8f3pZqV8ZImBK9RczHwy5FXOgKzJ5C-mg8Twzre6E">
        <title>${post.title} - ${blogTitleResult?.value || '我的博客'}</title>
        <link href="/assets/style.css" rel="stylesheet">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/atom-one-dark.min.css">
    </head>
    <body class="bg-slate-100 text-slate-800 font-sans">
        <div class="max-w-7xl mx-auto">
            <header 
                class="relative flex items-center justify-center text-center min-h-[10vh] md:min-h-[30vh] rounded-b-lg shadow-lg mb-8"
            style="
                background-image: url('/assets/banner.jpg');
                background-repeat: no-repeat;
                background-size: contain;
                background-attachment: fixed;
            "
            >
                <div class="absolute inset-0 bg-black opacity-50 rounded-b-lg"></div>
                <div class="relative text-center">
                    <h1 class="text-5xl font-extrabold tracking-tight drop-shadow-md">
                        <a href="/" class="text-white hover:text-white">${blogTitleResult?.value || '我的博客'}</a>
                    </h1>
                    <p class="mt-4 text-xl text-slate-200 drop-shadow-md">${subtitleResult?.value || 'A modern blog built with Cloudflare.'}</p>
                </div>
            </header>
            
            <div class="px-4 sm:px-6 lg:px-8">
                <nav class="my-6 bg-white p-3 rounded-lg shadow-md sticky top-2 z-10">
                    <ul class="flex justify-center space-x-2 md:space-x-4">
                        <li><a href="/" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">首页</a></li>
                        <li><a href="/#categories-widget" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">分类</a></li>
                        <li><a href="/#tags-widget" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">标签</a></li>
                        <li><a href="/#links-widget" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">友链</a></li>
                        <li><a href="/archive" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">归档</a></li>
                        <li><a href="/feed.xml" target="_blank" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">RSS订阅</a></li>
                    </ul>
                </nav>

                <div class="grid grid-cols-1 lg:grid-cols-4 gap-8">
                    <main class="lg:col-span-3">
                        <!-- 文章 -->
                        <article class="bg-white p-6 rounded-lg shadow-md hover:shadow-xl transition-shadow duration-300 ease-in-out">
                            <!-- 文章头部 -->
                            <div class="mb-6 text-center">
                                <h1 class="text-3xl font-bold text-slate-900 mb-4">${post.title}</h1>
                                <div class="text-sm text-slate-500 mb-4 flex items-center justify-center space-x-4">
                                    <span>发布于: ${new Date(publishedAt).toLocaleDateString()}</span>
                                    <span>${viewCount} 阅读</span>
                                    <span>${commentsCountResult?.count || 0} 评论</span>
                                    ${post.category ? `<span><a href="/category/${post.category}" class="hover:text-sky-600 transition-colors">${post.category}</a></span>` : ''}
                                </div>
                            </div>

                            <!-- 文章内容 -->
                            <div class="post-content prose prose-slate max-w-none mb-6">
                                ${bodyHtml}
                            </div>

                            <!-- 标签 -->
                            ${post.tags ? `
                            <div class="py-4 border-t border-slate-100 flex flex-wrap gap-2 mb-6">
                                <span class="text-sm font-medium text-slate-500">标签:</span>
                                ${JSON.parse(post.tags).map((tag: string) => `<a href="/tags/${tag}" class="text-sm text-sky-600 hover:underline">${tag}</a>`).join(', ')}
                            </div>
                            ` : ''}

                            <!-- 上下篇导航 -->
                            <div class="py-4 border-t border-slate-100 flex justify-between">
                                ${prevPost ? `<a href="/blog/${prevPost.slug}" class="text-sky-600 hover:underline flex items-center">‹ 上一篇: ${prevPost.title}</a>` : '<span class="text-slate-400">没有上一篇</span>'}
                                ${nextPost ? `<a href="/blog/${nextPost.slug}" class="text-sky-600 hover:underline flex items-center">下一篇: ${nextPost.title} ›</a>` : '<span class="text-slate-400">没有下一篇</span>'}
                            </div>
                        </article>

                        <!-- 评论区 -->
                        <div class="mt-8 bg-white p-6 rounded-lg shadow-md">
                            <h2 class="text-2xl font-bold text-slate-900 mb-6">评论 (${commentsCountResult?.count || 0})</h2>

                            <!-- 评论列表 -->
                            <div id="comments-list" class="space-y-4 mb-8">
                                ${commentsHtml}
                            </div>

                            <!-- 评论表单 -->
                            <form id="comment-form" class="mt-8">
                                <input type="hidden" id="comment-parent-id" value="">
                                <div id="reply-notice" class="hidden mb-4 p-3 bg-sky-50 border-l-4 border-sky-500">
                                    <div class="flex justify-between items-center">
                                        <div id="reply-text"></div>
                                        <button type="button" id="cancel-reply" class="text-sm text-sky-600 hover:underline">取消回复</button>
                                    </div>
                                </div>

                                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                    <div>
                                        <label for="comment-author" class="block text-sm font-medium text-slate-700 mb-1">昵称 *</label>
                                        <input type="text" id="comment-author" class="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent" required>
                                    </div>
                                    <div>
                                        <label for="comment-email" class="block text-sm font-medium text-slate-700 mb-1">邮箱 (选填)</label>
                                        <input type="email" id="comment-email" class="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent">
                                    </div>
                                </div>

                                <div class="mb-4">
                                    <label for="comment-content" class="block text-sm font-medium text-slate-700 mb-1">评论内容 *</label>
                                    <textarea id="comment-content" rows="4" class="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent" required></textarea>
                                </div>

                                <button type="submit" class="px-4 py-2 bg-sky-500 text-white font-semibold rounded-lg hover:bg-sky-600 transition-transform duration-300 hover:scale-105">提交评论</button>
                            </form>
                        </div>
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
                <p>&copy; ${new Date().getFullYear()} ${blogTitleResult?.value || '我的博客'}. <a href="/sitemap.xml" class="text-sky-500 hover:underline ml-2">站点地图.&nbsp;</a>访问我的<a href="https://github.com/qyidc" class="text-sky-500 hover:underline">Github</a></p>
            </footer>
        </div>
        
        <script>${clientScript}</script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
        <script>(function() { function initCodeFeatures() { if (!window.hljs) return setTimeout(initCodeFeatures, 50); const codeBlocks = document.querySelectorAll('.post-content pre code'); codeBlocks.forEach(block => { try { hljs.highlightElement(block); } catch(e) {} }); setTimeout(() => { codeBlocks.forEach(block => { try { const pre = block.parentElement; if (!pre || pre.querySelector('.code-header')) return; const header = document.createElement('div'); header.className = 'code-header'; header.style.cssText = 'display: flex !important; justify-content: space-between; align-items: center; padding: 0.75rem 1rem; background: #2d2d2d !important; border-bottom: 1px solid #444;'; let lang = 'CODE'; const match = block.className.match(/language-(\w+)/); if (match && match[1]) { lang = match[1].toUpperCase(); } const langSpan = document.createElement('span'); langSpan.style.cssText = 'color: #a5ff90 !important; font-size: 0.85rem; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas;'; langSpan.textContent = lang; const copyBtn = document.createElement('button'); copyBtn.style.cssText = 'background: #444 !important; color: white !important; border: none; border-radius: 0.25rem; padding: 0.25rem 0.75rem; font-size: 0.8rem; cursor: pointer; transition: background 0.2s;'; copyBtn.textContent = '复制'; copyBtn.onmouseover = () => copyBtn.style.background = '#555 !important'; copyBtn.onmouseout = () => copyBtn.style.background = '#444 !important'; copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(block.textContent || ''); copyBtn.textContent = '已复制！'; setTimeout(() => copyBtn.textContent = '复制', 2000); } catch(e) { copyBtn.textContent = '复制失败'; setTimeout(() => copyBtn.textContent = '复制', 2000); } }; header.appendChild(langSpan); header.appendChild(copyBtn); pre.insertBefore(header, block); } catch(e) {} }); }, 100); } initCodeFeatures(); })();</script>
        <script defer src="https://static.cloudflareinsights.com/beacon.min.js/v67327c56f0bb4ef8b305cae61679db8f1769101564043" integrity="sha512-rdcWY47ByXd76cbCFzznIcEaCN71jqkWBBqlwhF1SY7KubdLKZiEGeP7AyieKZlGP9hbY/MhGrwXzJC/HulNyg==" data-cf-beacon='{"version":"2024.11.0","token":"e6e7eaef3a72433391ea5c2bc637eb63","r":1,"server_timing":{"name":{"cfCacheStatus":true,"cfEdge":true,"cfExtPri":true,"cfL4":true,"cfOrigin":true,"cfSpeedBrain":true},"location_startswith":null}}' crossorigin="anonymous"></script>
    </body>
    </html>`;

    // 4. 上传到 R2 存储桶
    try {
        await env.STATIC_PAGES.put(post.slug, htmlContent, {
            httpMetadata: {
                contentType: 'text/html',
                cacheControl: 'public, max-age=3600' // 1小时缓存
            }
        });
        console.log(`Static page generated and stored for post: ${post.slug}`);
    } catch (error) {
        console.error('Error storing static page:', error);
        throw error;
    }
}

/**
 * 更新文章图片关联
 * 
 * @param db - D1 数据库实例
 * @param postId - 文章 ID
 * @param content - 文章内容
 * @param featureImage - 特色图片 URL
 */
async function updatePostImageRelations(db: D1Database, postId: string, content: string, featureImage?: string) {
    // 移除旧的图片关联
    await db.prepare('DELETE FROM post_images WHERE post_id = ?').bind(postId).run();

    // 提取内容中的图片
    const imageUrls = [];
    const imgRegex = /<img[^>]+src="([^"]+)"/g;
    let match;
    while ((match = imgRegex.exec(content)) !== null) {
        imageUrls.push(match[1]);
    }

    // 添加特色图片
    if (featureImage) {
        imageUrls.push(featureImage);
    }

    // 去重并添加关联
    const uniqueUrls = [...new Set(imageUrls)];
    for (const url of uniqueUrls) {
        await db.prepare('INSERT OR IGNORE INTO post_images (post_id, image_url) VALUES (?, ?)').bind(postId, url).run();
    }
}

/**
 * 检查 IP 是否在黑名单中
 * 
 * @param db - D1 数据库实例
 * @param ip - IP 地址
 * @returns 是否在黑名单中
 */
async function isIpBlacklisted(db: D1Database, ip: string): Promise<boolean> {
    const result = await db.prepare('SELECT id FROM ip_blacklist WHERE ip_address = ?').bind(ip).first();
    return !!result;
}

/**
 * 渲染首页
 * 
 * @param params - 渲染参数
 * @returns 首页 HTML
 */
async function renderHomePage(data: {
    env: any;
    posts: Post[];
    subtitle: string;
    blogTitle: string;
    currentPage: number;
    totalPages: number;
    pageTitle?: string; // 用于归档页和搜索结果页的自定义标题
    heroImageUrl?: string // 自定义背景图URL
}) {
    const { env, posts, subtitle, blogTitle, currentPage, totalPages, pageTitle, heroImageUrl } = data;
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
        <title>${pageTitle || blogTitle}</title>
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
                        <a href="/" class="text-white hover:text-white">${pageTitle || blogTitle}</a>
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
                        <li><a href="/archive" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">归档</a></li>
                        <li><a href="/feed.xml" target="_blank" class="px-3 py-2 text-slate-700 hover:bg-slate-200 rounded-md transition-colors">RSS订阅</a></li>
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
                <p>&copy; ${new Date().getFullYear()} ${blogTitle}. <a href="/sitemap.xml" class="text-sky-500 hover:underline ml-2">站点地图.&nbsp;</a>访问我的<a href="https://github.com/qyidc" class="text-sky-500 hover:underline">Github</a></p>
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
        <script defer src="https://static.cloudflareinsights.com/beacon.min.js/v67327c56f0bb4ef8b305cae61679db8f1769101564043" integrity="sha512-rdcWY47ByXd76cbCFzznIcEaCN71jqkWBBqlwhF1SY7KubdLKZiEGeP7AyieKZlGP9hbY/MhGrwXzJC/HulNyg==" data-cf-beacon='{"version":"2024.11.0","token":"e6e7eaef3a72433391ea5c2bc637eb63","r":1,"server_timing":{"name":{"cfCacheStatus":true,"cfEdge":true,"cfExtPri":true,"cfL4":true,"cfOrigin":true,"cfSpeedBrain":true},"location_startswith":null}}' crossorigin="anonymous"></script>
    </body>
    </html>`;
}
