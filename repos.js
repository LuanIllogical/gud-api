const normalize = (s) => (s || "").toLowerCase();

function extractGroups(readme) {
    const match = readme.match(/gud-repo-groups:\s*([\s\S]*?)-->/i);
    if (!match) return null;

    const block = match[1];

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
            return res.status(500).json({ error: "GitHub API error", debug: repos });
        }

        let groupsConfig = null;

        try {
            const readmeRes = await fetch(
                `https://raw.githubusercontent.com/${user}/${user}/main/README.md`
            );

            if (readmeRes.ok) {
                const readme = await readmeRes.text();
                groupsConfig = extractGroups(readme);
            }
        } catch (e) { }

        const repoMap = new Map(
            repos.map(r => [
                r.name,
                {
                    name: r.name,
                    html_url: r.html_url,
                    description: r.description
                }
            ])
        );

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

        const other = repos
            .filter(r => !used.has(r.name))
            .map(r => ({
                name: r.name,
                html_url: r.html_url,
                description: r.description
            }));

        return res.status(200).json({ grouped, other });

    } catch (err) {
        return res.status(500).json({
            error: "Server crashed",
            message: err.message
        });
    }
};