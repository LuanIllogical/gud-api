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
    const result = {
        languageTexts: {},
        cleanReadme: readme || ''
    };

    if (!readme) return result;

    let cleanReadme = readme;
    let currentLanguage = null;
    let currentContent = [];
    let inLanguageBlock = false;
    let isAltFormat = false;

    const lines = readme.split('\n');
    const newLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for language-begin
        const beginMatch = line.match(/<!--\s*language-begin\s*=\s*([A-Za-z0-9\-_]+)\s*-->/);
        const altBeginMatch = line.match(/<!--\s*language-begin\s*=\s*([A-Za-z0-9\-_]+)\s*$/);

        if (beginMatch) {
            // Standard format
            currentLanguage = beginMatch[1].trim();
            inLanguageBlock = true;
            isAltFormat = false;
            currentContent = [];
            // Don't add this line to cleanReadme (remove the marker)
            continue;
        } else if (altBeginMatch) {
            // Alternative format (no closing -->)
            currentLanguage = altBeginMatch[1].trim();
            inLanguageBlock = true;
            isAltFormat = true;
            currentContent = [];
            // Don't add this line to cleanReadme (remove the marker)
            continue;
        }

        // Check for language-end
        const endMatch = line.match(/<!--\s*language-end\s*=\s*([A-Za-z0-9\-_]+)\s*-->/);

        if (endMatch && inLanguageBlock && currentLanguage === endMatch[1].trim()) {
            // End of language block
            const content = currentContent.join('\n').trim();
            if (result.languageTexts[currentLanguage]) {
                result.languageTexts[currentLanguage] += ' ' + content;
            } else {
                result.languageTexts[currentLanguage] = content;
            }
            inLanguageBlock = false;
            currentLanguage = null;
            currentContent = [];
            // Don't add this line to cleanReadme (remove the marker)
            continue;
        }

        // Check for alt format end (no HTML comment wrapper)
        if (isAltFormat && inLanguageBlock && line.includes(`language-end = ${currentLanguage}`)) {
            // End of alt language block
            const content = currentContent.join('\n').trim();
            if (result.languageTexts[currentLanguage]) {
                result.languageTexts[currentLanguage] += ' ' + content;
            } else {
                result.languageTexts[currentLanguage] = content;
            }
            inLanguageBlock = false;
            currentLanguage = null;
            isAltFormat = false;
            currentContent = [];
            // Don't add this line (remove the marker)
            continue;
        }

        // If we're in a language block, collect content
        if (inLanguageBlock) {
            currentContent.push(line);
            // Don't add to cleanReadme (these are language-specific)
        } else {
            // Not in a language block, keep in cleanReadme
            newLines.push(line);
        }
    }

    // Also capture any remaining content (like the second EN tag)
    result.cleanReadme = newLines.join('\n');

    return result;
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
            groupsConfig = extractGroups(readme);
            const extracted = extractLanguageSections(readme);
            languageTexts = extracted.languageTexts;

            // Process the clean README (with markers removed)
            const { marked } = await import('marked');
            const createDOMPurify = await import('dompurify');
            const { JSDOM } = await import('jsdom');

            const window = new JSDOM("").window;
            const DOMPurify = createDOMPurify.default(window);

            marked.setOptions({
                mangle: false,
                headerIds: false
            });

            // Get the full HTML structure (without any markers)
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