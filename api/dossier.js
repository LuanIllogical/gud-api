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

async function fetchContributionData(username, token) {
    try {
        const query = `
            query($username: String!) {
                user(login: $username) {
                    contributionsCollection {
                        contributionCalendar {
                            totalContributions
                            weeks {
                                contributionDays {
                                    date
                                    contributionCount
                                    color
                                }
                            }
                        }
                    }
                }
            }
        `;

        const response = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'repo-viewer'
            },
            body: JSON.stringify({
                query: query,
                variables: { username: username }
            })
        });

        const data = await response.json();

        if (data.errors) {
            console.error('GraphQL errors:', data.errors);
            return null;
        }

        const calendar = data.data?.user?.contributionsCollection?.contributionCalendar;
        if (!calendar) return null;

        const contributions = [];
        calendar.weeks.forEach(week => {
            week.contributionDays.forEach(day => {
                contributions.push({
                    date: day.date,
                    count: day.contributionCount,
                    level: getContributionLevel(day.contributionCount),
                    color: day.color
                });
            });
        });

        return {
            total: calendar.totalContributions,
            contributions: contributions
        };
    } catch (err) {
        console.error('Error fetching contributions:', err);
        return null;
    }
}

function getContributionLevel(count) {
    if (count === 0) return 0;
    if (count <= 3) return 1;
    if (count <= 6) return 2;
    if (count <= 9) return 3;
    return 4;
}

async function fetchRecentActivity(username, token) {
    try {
        const response = await fetch(
            `https://api.github.com/users/${username}/events?per_page=30`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'repo-viewer'
                }
            }
        );

        if (!response.ok) return [];

        const events = await response.json();

        return events.map(event => ({
            id: event.id,
            type: event.type,
            repo: {
                name: event.repo.name,
                url: `https://github.com/${event.repo.name}`
            },
            created_at: event.created_at,
            payload: sanitizeEventPayload(event.type, event.payload),
            actor: {
                login: event.actor.login,
                avatar: event.actor.avatar_url
            }
        }));
    } catch (err) {
        console.error('Error fetching activity:', err);
        return [];
    }
}

function sanitizeEventPayload(type, payload) {
    const sanitized = {};

    switch (type) {
        case 'PushEvent':
            sanitized.commits = (payload.commits || []).slice(0, 3).map(c => ({
                message: c.message.length > 100 ? c.message.substring(0, 97) + '...' : c.message,
                sha: c.sha.substring(0, 7),
                url: c.url
            }));
            sanitized.ref = payload.ref?.replace('refs/heads/', '');
            sanitized.size = payload.size;
            sanitized.distinct_size = payload.distinct_size;
            break;
        case 'CreateEvent':
            sanitized.ref_type = payload.ref_type;
            sanitized.ref = payload.ref;
            break;
        case 'IssuesEvent':
            if (payload.issue) {
                sanitized.action = payload.action;
                sanitized.issue = {
                    number: payload.issue.number,
                    title: payload.issue.title.length > 80 ? payload.issue.title.substring(0, 77) + '...' : payload.issue.title,
                    url: payload.issue.html_url
                };
            }
            break;
        case 'PullRequestEvent':
            if (payload.pull_request) {
                sanitized.action = payload.action;
                sanitized.pr = {
                    number: payload.pull_request.number,
                    title: payload.pull_request.title.length > 80 ? payload.pull_request.title.substring(0, 77) + '...' : payload.pull_request.title,
                    url: payload.pull_request.html_url
                };
            }
            break;
        case 'WatchEvent':
            sanitized.action = payload.action;
            break;
        case 'ForkEvent':
            if (payload.forkee) {
                sanitized.forkee = {
                    full_name: payload.forkee.full_name,
                    url: payload.forkee.html_url
                };
            }
            break;
        case 'IssueCommentEvent':
            if (payload.comment && payload.issue) {
                sanitized.action = payload.action;
                sanitized.body = payload.comment.body?.length > 100 ? payload.comment.body.substring(0, 97) + '...' : payload.comment.body;
                sanitized.issue_number = payload.issue.number;
            }
            break;
        default:
            sanitized.action = payload.action;
    }

    return sanitized;
}

function adaptContributionColorsToBackground(backgroundCSS, contributionData) {
    if (!contributionData || !contributionData.contributions) return contributionData;

    let backgroundType = 'dark';
    let baseHue = 142;

    if (backgroundCSS) {
        if (backgroundCSS.includes('linear-gradient') || backgroundCSS.includes('radial-gradient')) {
            const colorMatches = backgroundCSS.match(/#[0-9a-f]{6}|#[0-9a-f]{3}|rgb\([^)]+\)|hsl\([^)]+\)/gi);
            if (colorMatches && colorMatches.length > 0) {
                const dominantColor = colorMatches[0];
                baseHue = getHueFromColor(dominantColor);
            }
        } else if (backgroundCSS.includes('#')) {
            const colorMatch = backgroundCSS.match(/#[0-9a-f]{6}|#[0-9a-f]{3}/);
            if (colorMatch) {
                baseHue = getHueFromColor(colorMatch[0]);
            }
        }

        if (backgroundCSS.toLowerCase().includes('white') ||
            backgroundCSS.includes('#fff') ||
            backgroundCSS.includes('#f') ||
            (backgroundCSS.includes('rgb') && backgroundCSS.match(/\d+/g)?.[0] > 200)) {
            backgroundType = 'light';
        } else {
            backgroundType = 'dark';
        }
    }

    const contributionColors = generateContributionColors(baseHue, backgroundType);

    contributionData.contributions = contributionData.contributions.map(contrib => ({
        ...contrib,
        adaptedColor: contributionColors[contrib.level] || contributionColors[0]
    }));

    contributionData.colorScheme = contributionColors;

    return contributionData;
}

function getHueFromColor(color) {
    let r, g, b;

    if (color.startsWith('#')) {
        const hex = color.substring(1);
        if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length === 6) {
            r = parseInt(hex.substring(0, 2), 16);
            g = parseInt(hex.substring(2, 4), 16);
            b = parseInt(hex.substring(4, 6), 16);
        } else {
            return 142;
        }
    } else if (color.startsWith('rgb')) {
        const matches = color.match(/\d+/g);
        if (matches && matches.length >= 3) {
            r = parseInt(matches[0]);
            g = parseInt(matches[1]);
            b = parseInt(matches[2]);
        } else {
            return 142;
        }
    } else {
        return 142;
    }

    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let hue = 0;

    if (max === min) {
        hue = 0;
    } else if (max === r) {
        hue = 60 * ((g - b) / (max - min));
    } else if (max === g) {
        hue = 60 * (2 + (b - r) / (max - min));
    } else {
        hue = 60 * (4 + (r - g) / (max - min));
    }

    if (hue < 0) hue += 360;

    return hue;
}

function generateContributionColors(baseHue, backgroundType) {
    if (backgroundType === 'dark') {
        return {
            fills: [
                `hsla(${baseHue}, 20%, 10%, 0.15)`,
                `hsla(${baseHue}, 60%, 22%, 0.55)`,
                `hsla(${baseHue}, 65%, 32%, 0.65)`,
                `hsla(${baseHue}, 70%, 44%, 0.72)`,
                `hsla(${baseHue}, 75%, 56%, 0.80)`,
            ],
            borders: [
                `hsla(${baseHue}, 20%, 30%, 0.18)`,
                `hsla(${baseHue}, 65%, 40%, 0.70)`,
                `hsla(${baseHue}, 70%, 52%, 0.80)`,
                `hsla(${baseHue}, 75%, 62%, 0.85)`,
                `hsla(${baseHue}, 80%, 72%, 0.90)`,
            ]
        };
    } else {
        return {
            fills: [
                `hsla(${baseHue}, 15%, 90%, 0.40)`,
                `hsla(${baseHue}, 50%, 60%, 0.55)`,
                `hsla(${baseHue}, 55%, 48%, 0.65)`,
                `hsla(${baseHue}, 60%, 38%, 0.75)`,
                `hsla(${baseHue}, 65%, 28%, 0.85)`,
            ],
            borders: [
                `hsla(${baseHue}, 15%, 70%, 0.25)`,
                `hsla(${baseHue}, 55%, 72%, 0.70)`,
                `hsla(${baseHue}, 60%, 60%, 0.80)`,
                `hsla(${baseHue}, 65%, 50%, 0.85)`,
                `hsla(${baseHue}, 70%, 40%, 0.90)`,
            ]
        };
    }
}

module.exports = async (req, res) => {
    try {
        res.setHeader("Access-Control-Allow-Origin", "*"); // https://luanillogical.github.io
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

        try {
            contributionData = await fetchContributionData(user, process.env.GITHUB_TOKEN);

            if (contributionData && backgroundCSS) {
                contributionData = adaptContributionColorsToBackground(backgroundCSS, contributionData);
            }
        } catch (err) {
            console.error('Failed to fetch contributions:', err);
        }

        let recentActivity = [];
        try {
            recentActivity = await fetchRecentActivity(user, process.env.GITHUB_TOKEN);
        } catch (err) {
            console.error('Failed to fetch activity:', err);
        }

        return res.status(200).json({
            user: userData,
            readme: sanitizedHTML,
            languageTexts: languageTexts,
            backgroundCSS: backgroundCSS,
            repos: {
                grouped,
                other
            },
            contributions: contributionData,
            recentActivity: recentActivity
        });

    } catch (err) {
        console.error('Error:', err);
        return res.status(500).json({
            error: "Server crashed",
            message: err.message
        });
    }
};