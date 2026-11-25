/**
 * DX-Compass Node-RED Settings
 * Port: 5758
 */

const zlib = require("zlib");

/**
 * 弱网优化：给 REST 的 JSON 响应加 gzip。
 *
 * 现场是低带宽远端链路，/api/devices 这类响应有几十 KB，裸传时 `receive`
 * 能拖到十几秒，正好撞上前端 15s 超时被 abort，进而触发画布清空/刷新失败。
 * gzip 把 JSON 压到约 1/10，既治弱网又提升实时性（小包更快到齐）。
 *
 * 用 Node 内置 zlib，零新增依赖，可随 `git pull + 重启`直接生效。
 *
 * 安全边界（刻意做窄，避免误伤）：
 *   - 只拦 GET、状态 2xx、Content-Type 为 application/json 的“单发”响应；
 *   - 只覆写 res.end，绝不碰 res.write —— camera 的 multipart 流、任何
 *     chunked/SSE 端点都原样透传，不会被缓冲打断；
 *   - 体积阈值 1KB～5MB，太小不值得压、太大不占 CPU；
 *   - 任何异常或客户端已断开，都回退到原始 end，保持既有行为。
 */
function compressApiResponse(req, res, next) {
    try {
        const acceptsGzip = /gzip/.test(String(req.headers["accept-encoding"] || ""));
        if (!acceptsGzip || req.method !== "GET") {
            return next();
        }
        const originalEnd = res.end;
        res.end = function (chunk, encoding, callback) {
            // 先恢复，杜绝重入；只对带完整 body 的单发响应做处理。
            res.end = originalEnd;
            try {
                const contentType = String(res.getHeader("Content-Type") || "");
                const statusOk = res.statusCode >= 200 && res.statusCode < 300;
                const isJson = /application\/json/i.test(contentType);
                const hasBody = chunk !== undefined && chunk !== null && chunk !== "";
                if (!hasBody || !isJson || !statusOk) {
                    return originalEnd.call(res, chunk, encoding, callback);
                }
                const raw = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);
                if (raw.length < 1024 || raw.length > 5 * 1024 * 1024) {
                    return originalEnd.call(res, chunk, encoding, callback);
                }
                zlib.gzip(raw, { level: 6 }, (err, gz) => {
                    if (err || res.destroyed || res.writableEnded) {
                        finish(raw);
                        return;
                    }
                    try {
                        res.setHeader("Content-Encoding", "gzip");
                        res.setHeader("Vary", "Accept-Encoding");
                        res.removeHeader("ETag");
                        res.setHeader("Content-Length", gz.length);
                        originalEnd.call(res, gz, callback);
                    } catch (writeError) {
                        // 客户端已断开等：忽略，勿在异步回调里抛出未捕获异常。
                    }
                });
                return res;
            } catch (inner) {
                res.end = originalEnd;
                return originalEnd.call(res, chunk, encoding, callback);
            }
        };
        function finish(raw) {
            try {
                if (!res.destroyed && !res.writableEnded) {
                    originalEnd.call(res, raw);
                }
            } catch (ignored) {}
        }
        return next();
    } catch (fatal) {
        return next();
    }
}

module.exports = {
    uiPort: 5758,
    uiHost: "0.0.0.0",

    // Flow file
    flowFile: "flow.json",
    flowFilePretty: true,

    // Credentials
    credentialSecret: false,

    // Serve the custom DX-Compass frontend at "/" (httpStatic takes root
    // once the admin editor is moved away from its default root path)
    httpStatic: "public",

    // Node-RED admin editor is disabled: /red is not part of the product
    // surface (returns 404 to every request). Edit flow.json directly and
    // restart the service instead of using the browser editor.
    httpAdminRoot: false,

    // Root for HTTP-in nodes (REST API)
    httpNodeRoot: "/",

    // 弱网优化：REST JSON 响应 gzip（详见文件顶部 compressApiResponse 注释）。
    httpNodeMiddleware: compressApiResponse,

    // functionGlobalContext exposes the shared dx domain facade to function
    // nodes. functionExternalModules is intentionally NOT enabled here -- it
    // spins up the runtime npm loader on startup, which can crash Node-RED if
    // npm / the module cache has permission issues. functionGlobalContext
    // works independently and is all we need.
    functionGlobalContext: {
        dx: require("./lib")
    },

    // Persist context to disk so settings (callsigns, home lat/lon) survive restarts
    contextStorage: {
        default: {
            module: "localfilesystem"
        }
    },

    // Enable cross-origin requests for the frontend
    httpNodeCors: {
        origin: "*",
        methods: "GET,PUT,POST,DELETE,OPTIONS",
        allowedHeaders: "Content-Type"
    },

    // Max HTTP request size
    apiMaxLength: "50mb",

    // Logging
    logging: {
        console: {
            level: "info",
            metrics: false,
            audit: false
        }
    },

    // Editor
    editorTheme: {
        page: {
            title: "DX-Compass"
        },
        header: {
            title: "DX-Compass",
            image: ""
        }
    }
};
