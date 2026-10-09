/**
 * DX-Compass Node-RED Settings
 * Port: 5758
 */

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

    // Node-RED admin editor lives at "/red" (root "/" must stay free for the dashboard)
    httpAdminRoot: "/red",

    // Root for HTTP-in nodes (REST API)
    httpNodeRoot: "/",

    // Allow function nodes to use httpRequest and other core modules
    functionGlobalContext: {
        // os: require("os"),
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
