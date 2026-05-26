const normalize = (s) => (s || "").toLowerCase();

function extractGroups(readme) {
    const start = readme.indexOf("gud-repo-groups:");
    const end = readme.indexOf("-->", start);

    if (start === -1 || end === -1) return null;

    const block = readme.slice(start, end);

    const groups = {};

    const lines = block
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.includes("="));

    for (const line of lines) {
        const [left, right] = line.split("=");
        if (!left || !right) continue;

        const groupName = left.trim();

        const repos = right
            .split(",")
            .map(r => r.trim())
            .filter(Boolean);

        groups[groupName] = repos;
    }

    return groups;
}

function extractLanguageSections(readme) {
    const sections = {};
    if (!readme) return { sections: {}, commonContent: '' };

    let commonContent = readme;

    const defaultRegex = /<!--\s*default-language-begin\s*=\s*([A-Za-z0-9\-_]+)\s*-->([\s\S]*?)<!--\s*default-language-end\s*=\s*\1\s*-->/gi;

    let match;
    while ((match = defaultRegex.exec(readme)) !== null) {
        const langCode = match[1].trim();
        let content = match[2].trim();
        sections[langCode] = content;
        commonContent = commonContent.replace(match[0], '');
    }

    const altRegex = /<!--\s*language-begin\s*=\s*([A-Za-z0-9\-_]+)\s*([\s\S]*?)language-end\s*=\s*\1\s*-->/gi;

    while ((match = altRegex.exec(readme)) !== null) {
        const langCode = match[1].trim();
        let content = match[2].trim();
        content = content.replace(/-->$/, '').trim();
        sections[langCode] = content;
        commonContent = commonContent.replace(match[0], '');
    }

    return {
        languageContent: sections,
        commonContent: commonContent.trim()
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
        let readmeHTML = null;
        let languageSections = {};
        let commonContentHTML = '';

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

        let groupsConfig = null;
        let extractedLanguages = null;

        if (readme) {
            groupsConfig = extractGroups(readme);
            extractedLanguages = extractLanguageSections(readme);

            const { marked } = await import('marked');
            const createDOMPurify = await import('dompurify');
            const { JSDOM } = await import('jsdom');

            const window = new JSDOM("").window;
            const DOMPurify = createDOMPurify.default(window);

            marked.setOptions({
                mangle: false,
                headerIds: false
            });

            if (extractedLanguages.commonContent) {
                const commonHTML = await marked.parse(extractedLanguages.commonContent);
                commonContentHTML = DOMPurify.sanitize(commonHTML);
            }

            for (const [langCode, content] of Object.entries(extractedLanguages.languageContent)) {
                const rawHTML = await marked.parse(content);
                languageSections[langCode] = DOMPurify.sanitize(rawHTML);
            }

            const rawHTML = await marked.parse(readme);
            readmeHTML = DOMPurify.sanitize(rawHTML);
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
            readme: readmeHTML,
            languageSections: languageSections,
            commonContent: commonContentHTML,
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