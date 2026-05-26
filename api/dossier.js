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
    const languageContent = {};
    let commonContent = readme;

    if (!readme) return { languageContent: {}, commonContent: '' };

    // Extract default language format as plain text
    const defaultRegex = /<!--\s*default-language-begin\s*=\s*([A-Za-z0-9\-_]+)\s*-->([\s\S]*?)<!--\s*default-language-end\s*=\s*\1\s*-->/g;

    let match;
    while ((match = defaultRegex.exec(readme)) !== null) {
        const langCode = match[1].trim();
        let content = match[2].trim();
        // Store as plain text, not HTML
        languageContent[langCode] = content;
        // Remove the markers but keep the content visible
        commonContent = commonContent.replace(match[0], content);
    }

    // Extract alternative language format as plain text
    const altRegex = /<!--\s*language-begin\s*=\s*([A-Za-z0-9\-_]+)\s*([\s\S]*?)language-end\s*=\s*\1\s*-->/g;

    while ((match = altRegex.exec(readme)) !== null) {
        const langCode = match[1].trim();
        let content = match[2].trim();
        // Store as plain text
        languageContent[langCode] = content;
        // Remove the markers but keep the content visible
        commonContent = commonContent.replace(match[0], content);
    }

    // Remove any remaining language markers from common content
    commonContent = commonContent.replace(/<!--\s*default-language-begin[\s\S]*?-->/g, '');
    commonContent = commonContent.replace(/<!--\s*language-begin[\s\S]*?language-end[\s\S]*?-->/g, '');

    return {
        languageContent: languageContent,
        commonContent: commonContent.trim()
    };
}

function insertBeforeClosingDivs(html, commonHTML) {
    if (!commonHTML) return html;

    const lastDivIndex = html.lastIndexOf('</div>');
    if (lastDivIndex !== -1) {
        return html.slice(0, lastDivIndex) + commonHTML + html.slice(lastDivIndex);
    }
    return html + commonHTML;
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

        if (readme) {
            groupsConfig = extractGroups(readme);
            const extracted = extractLanguageSections(readme);

            // Process the FULL readme once to get the complete HTML structure
            const { marked } = await import('marked');
            const createDOMPurify = await import('dompurify');
            const { JSDOM } = await import('jsdom');

            const window = new JSDOM("").window;
            const DOMPurify = createDOMPurify.default(window);

            marked.setOptions({
                mangle: false,
                headerIds: false
            });

            // Get the complete HTML structure
            const fullHTML = await marked.parse(readme);
            const sanitizedFullHTML = DOMPurify.sanitize(fullHTML);

            // Store the full HTML as fallback
            readmeHTML = sanitizedFullHTML;

            // For each language, we'll replace just the text content
            // But since we can't easily replace text in HTML, we'll store the plain text
            // and let the frontend do text replacement on the DOM
            languageSections = extracted.languageContent;
            commonContent = extracted.commonContent;
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
            commonContent: commonContent,
            repos: { grouped, other }
        });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({
            error: "Server crashed",
            message: err.message
        });
    }
};