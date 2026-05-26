const normalize = (s) => (s || "").toLowerCase();

function parseGudConfig(readme) {
    const config = {};

    if (!readme) return config;

    const gudBlockMatch = readme.match(/<!--\s*([\s\S]*?)\s*-->/);
    if (!gudBlockMatch) return config;

    const block = gudBlockMatch[1];

    const sections = block.split(/\n(?=gud-)/);

    for (const section of sections) {
        const match = section.match(/^gud-([a-z-]+):\s*{\s*([\s\S]*?)\s*}\s*$/);
        if (match) {
            const key = match[1];
            let value = match[2].trim();
            config[key] = value;
        }
    }

    return config;
}

function extractGroupsFromConfig(groupsConfig) {
    if (!groupsConfig) return null;

    const groups = {};
    const lines = groupsConfig.split("\n");

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        const equalIndex = trimmedLine.indexOf("=");
        if (equalIndex === -1) continue;

        const groupName = trimmedLine.substring(0, equalIndex).trim();
        const reposStr = trimmedLine.substring(equalIndex + 1).trim();

        const repos = reposStr
            .split(",")
            .map(r => r.trim())
            .filter(Boolean);

        if (groupName && repos.length > 0) {
            groups[groupName] = repos;
        }
    }

    return Object.keys(groups).length > 0 ? groups : null;
}

function extractBackgroundFromConfig(backgroundConfig) {
    if (!backgroundConfig) return null;
    return backgroundConfig.replace(/\s+/g, ' ').trim();
}

function extractLanguageSections(readme) {
    const languageTexts = {};

    if (!readme) return { languageTexts: {}, cleanReadme: '', hasLanguageTags: false };

    let cleanReadme = readme;

    const regex = /<!--\s*language-begin\s*=\s*([A-Za-z0-9\-_]+)\s*(?:-->)?\s*([\s\S]*?)\s*language-end\s*=\s*\1\s*-->/g;

    let match;
    let hasLanguageTags = false;

    while ((match = regex.exec(readme)) !== null) {
        hasLanguageTags = true;
        const langCode = match[1].trim();
        let content = match[2].trim();
        // Clean up any remaining markers
        content = content.replace(/<!--/g, '').replace(/-->$/g, '').trim();

        languageTexts[langCode] = content;
        cleanReadme = cleanReadme.replace(match[0], '');
    }
    cleanReadme = cleanReadme.replace(/\n\s*\n/g, '\n').trim();
    cleanReadme = cleanReadme.replace(/<!--[\s\S]*?-->/g, '');

    return {
        languageTexts: languageTexts,
        cleanReadme: cleanReadme,
        hasLanguageTags: hasLanguageTags
    };
}

module.exports = async (req, res) => {
    try {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
            return res.status(200).end();
        }

        const user = req.query.user;

        if (!user) {
            return res.status(400).json({ error: "Missing user" });
        }

        const userRes = await fetch(
            `https://api.github.com/users/${user}`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                    "User-Agent": "repo-viewer"
                }
            }
        );

        const userData = await userRes.json();

        if (!userRes.ok) {
            return res.status(500).json({
                error: "Failed to fetch user",
                debug: userData
            });
        }

        const repoRes = await fetch(
            `https://api.github.com/users/${user}/repos?per_page=100`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                    "User-Agent": "repo-viewer"
                }
            }
        );

        const repos = await repoRes.json();

        if (!Array.isArray(repos)) {
            return res.status(500).json({
                error: "GitHub API error",
                debug: repos
            });
        }

        let readme = null;
        let groupsConfig = null;
        let languageTexts = {};
        let sanitizedHTML = '';
        let backgroundCSS = null;

        const branches = ["main", "master"];

        for (const branch of branches) {
            const resReadme = await fetch(
                `https://raw.githubusercontent.com/${user}/${user}/${branch}/README.md`
            );

            if (resReadme.ok) {
                readme = await resReadme.text();
                break;
            }
        }

        if (readme) {
            const gudConfig = parseGudConfig(readme);

            if (gudConfig['repo-groups']) {
                groupsConfig = extractGroupsFromConfig(gudConfig['repo-groups']);
            }

            if (gudConfig['background']) {
                backgroundCSS = extractBackgroundFromConfig(gudConfig['background']);
            }

            const extracted = extractLanguageSections(readme);
            languageTexts = extracted.languageTexts;


            const { marked } = await import('marked');
            const createDOMPurify = await import('dompurify');
            const { JSDOM } = await import('jsdom');

            const window = new JSDOM("").window;
            const DOMPurify = createDOMPurify.default(window);

            marked.setOptions({
                mangle: false,
                headerIds: false
            });

            const fullHTML = await marked.parse(extracted.cleanReadme);
            sanitizedHTML = DOMPurify.sanitize(fullHTML);
        }

        const grouped = {};
        const used = new Set();

        if (groupsConfig) {
            for (const [groupName, repoList] of Object.entries(groupsConfig)) {
                grouped[groupName] = [];

                for (const repoName of repoList) {
                    const match = repos.find(
                        r => normalize(r.name) === normalize(repoName)
                    );

                    if (match) {
                        grouped[groupName].push(match);
                        used.add(match.name);
                    }
                }
            }
        }

        const other = repos.filter(r => !used.has(r.name));

        return res.status(200).json({
            user: userData,
            readme: sanitizedHTML,
            languageTexts: languageTexts,
            backgroundCSS: backgroundCSS,
            repos: {
                grouped,
                other
            }
        });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({
            error: "Server crashed",
            message: err.message
        });
    }
};