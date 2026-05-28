const normalize = (s) => (s || "").toLowerCase();

function parseGudConfig(readme) {
    const config = {};

    if (!readme) return config;

    const configMatch = readme.match(/<!--\s*([\s\S]*?(?:gud-repo-groups|gud-background)[\s\S]*?)-->/);
    if (!configMatch) return config;

    const block = configMatch[1];

    const repoGroupsMatch = block.match(/gud-repo-groups:\s*{\s*([\s\S]*?)\s*}\s*(?=gud-background:|$)/);
    if (repoGroupsMatch && repoGroupsMatch[1].trim()) {
        config['repo-groups'] = repoGroupsMatch[1].trim();
    }

    const backgroundMatch = block.match(/gud-background:\s*{\s*([\s\S]*?)\s*}\s*$/);
    if (backgroundMatch && backgroundMatch[1].trim()) {
        config['background'] = backgroundMatch[1].trim();
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

    const value = backgroundConfig.replace(/\s+/g, ' ').trim();

    const dangerousPatterns = [
        /javascript:/i,
        /expression\s*\(/i,
        /@import/i,
        /<script/i
    ];

    if (dangerousPatterns.some(pattern => pattern.test(value))) {
        return null;
    }

    return value;
}

function extractLanguageSections(readme) {
    const languageTexts = {};

    if (!readme) return { languageTexts: {}, cleanReadme: '', hasLanguageTags: false };

    let cleanReadme = readme;

    const configBlockMatch = cleanReadme.match(/<!--\s*[\s\S]*?(?:gud-repo-groups|gud-background)[\s\S]*?-->/);
    if (configBlockMatch) {
        cleanReadme = cleanReadme.replace(configBlockMatch[0], '');
    }

    const regex = /<!--\s*gud-language-begin\s*=\s*([A-Za-z0-9\-_]+)\s*(?:-->)?\s*([\s\S]*?)\s*gud-language-end\s*=\s*\1\s*-->/g;

    let match;
    let hasLanguageTags = false;

    const matches = [];
    while ((match = regex.exec(readme)) !== null) {
        matches.push(match);
    }

    for (const match of matches) {
        hasLanguageTags = true;
        const langCode = match[1].trim();
        let content = match[2].trim();
        content = content.replace(/<!--/g, '').replace(/-->$/g, '').trim();

        languageTexts[langCode] = content;
        cleanReadme = cleanReadme.replace(match[0], '');
    }

    cleanReadme = cleanReadme.replace(/\n\s*\n/g, '\n').trim();

    console.log('Found languages:', Object.keys(languageTexts));

    return {
        languageTexts: languageTexts,
        cleanReadme: cleanReadme || 'No README content',
        hasLanguageTags: hasLanguageTags
    };
}

module.exports = async (req, res) => {
    try {
        res.setHeader("Access-Control-Allow-Origin", "*"); //https://luanillogical.github.io
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

        let repos = [];
        let page = 1;

        while (true) {
            const repoRes = await fetch(
                `https://api.github.com/users/${user}/repos?per_page=100&page=${page}`,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                        "User-Agent": "repo-viewer"
                    }
                }
            );

            const pageRepos = await repoRes.json();

            if (!repoRes.ok) {
                return res.status(500).json({
                    error: "GitHub API error",
                    debug: pageRepos
                });
            }

            if (!Array.isArray(pageRepos)) {
                return res.status(500).json({
                    error: "Invalid repo response",
                    debug: pageRepos
                });
            }

            repos.push(...pageRepos);

            if (pageRepos.length < 100) {
                break;
            }

            page++;
        }

        let readme = null;
        let groupsConfig = null;
        let languageTexts = {};
        let sanitizedHTML = '';
        let backgroundCSS = null;

        const readmeRes = await fetch(
            `https://api.github.com/repos/${user}/${user}/readme`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                    "User-Agent": "repo-viewer",
                    Accept: "application/vnd.github.raw"
                }
            }
        );

        if (readmeRes.ok) {
            readme = await readmeRes.text();
        } else {
            console.log("README not found");
        }

        if (readme) {
            const gudConfig = parseGudConfig(readme);

            if (gudConfig['repo-groups']) {
                groupsConfig = extractGroupsFromConfig(gudConfig['repo-groups']);
                console.log('Groups config extracted:', groupsConfig ? Object.keys(groupsConfig) : 'none');
            }

            if (gudConfig['background']) {
                backgroundCSS = extractBackgroundFromConfig(gudConfig['background']);
                console.log('Background CSS extracted:', backgroundCSS ? 'yes' : 'none');
            }

            const extracted = extractLanguageSections(readme);
            languageTexts = extracted.languageTexts;
            console.log('Language texts found:', Object.keys(languageTexts));

            const { marked } = await import('marked');
            const createDOMPurify = await import('dompurify');
            const { JSDOM } = await import('jsdom');

            const jsdom = new JSDOM("");
            const DOMPurify = createDOMPurify.default(jsdom.window);
            marked.setOptions({
                mangle: false,
                headerIds: false
            });

            const fullHTML = await marked.parse(extracted.cleanReadme, {
                mangle: false,
                headerIds: false
            });
            sanitizedHTML = DOMPurify.sanitize(fullHTML);

            jsdom.window.close();
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