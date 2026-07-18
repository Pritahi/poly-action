const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Lightweight HTTP Client (no axios needed) ─────────────────────
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

// ─── Lightweight XML Parser (no fast-xml-parser needed) ─────────────
function parseJUnitXML(xmlContent) {
  const tests = [];

  // Extract all <testcase> blocks
  const testcaseRegex = /<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;

  while ((match = testcaseRegex.exec(xmlContent)) !== null) {
    const attrs = match[1];
    const inner = match[2] || '';

    const nameMatch = attrs.match(/name="([^"]*)"/);
    const classMatch = attrs.match(/classname="([^"]*)"/);
    const timeMatch = attrs.match(/time="([^"]*)"/);

    const name = nameMatch ? nameMatch[1] : 'unknown';
    const classname = classMatch ? classMatch[1] : '';
    const duration = timeMatch ? parseFloat(timeMatch[1]) : 0;

    let status = 'passed';
    let message = '';

    if (inner.includes('<failure')) {
      status = 'failed';
      const msgMatch = inner.match(/message="([^"]*)"/);
      message = msgMatch ? msgMatch[1] : '';
    } else if (inner.includes('<error')) {
      status = 'error';
      const msgMatch = inner.match(/message="([^"]*)"/);
      message = msgMatch ? msgMatch[1] : '';
    } else if (inner.includes('<skipped')) {
      status = 'skipped';
    }

    tests.push({ name, classname, duration, status, message: message.substring(0, 500) });
  }

  return tests;
}

// ─── Find files by glob pattern ────────────────────────────────────
function findFiles(pattern) {
  const dir = path.dirname(pattern);
  const ext = path.extname(pattern);
  const base = path.basename(pattern).replace(ext, '').replace('*', '');

  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => {
      if (ext && !f.endsWith(ext)) return false;
      if (base && !f.includes(base.replace(/\*/g, ''))) return false;
      return true;
    })
    .map(f => path.join(dir, f));
}

// ─── Build PR Comment ──────────────────────────────────────────────
function buildComment(data) {
  const { repo_name, total_tests, avg_trust, flaky_count, quarantined, tests, run_id } = data;

  const scoreColor = avg_trust >= 80 ? '🟢' : avg_trust >= 50 ? '🟡' : '🔴';
  const flakyEmoji = flaky_count === 0 ? '✅' : flaky_count <= 3 ? '⚠️' : '🚨';

  let comment = `## ${scoreColor} Falsky Trust Report\n\n`;
  comment += `**Repository:** \`${repo_name}\`\n`;
  if (run_id) comment += `**Run ID:** \`${run_id}\`\n`;
  comment += `**Analyzed:** ${new Date().toISOString().split('T')[0]}\n\n`;

  comment += `| Metric | Value |\n`;
  comment += `|--------|-------|\n`;
  comment += `| Total Tests | ${total_tests} |\n`;
  comment += `| Avg Trust Score | **${avg_trust}/100** ${scoreColor} |\n`;
  comment += `| Flaky Tests | ${flaky_count} ${flakyEmoji} |\n`;
  if (quarantined > 0) comment += `| Quarantined | 🧪 ${quarantined} |\n`;
  comment += `\n`;

  const flakyTests = (tests || []).filter(t => t.trust_score < 50).sort((a, b) => a.trust_score - b.trust_score);

  if (flakyTests.length > 0) {
    comment += `### 🔬 Flaky Tests\n\n`;
    comment += `| Test | Trust | Category | Trend |\n`;
    comment += `|------|-------|----------|-------|\n`;

    for (const t of flakyTests.slice(0, 15)) {
      const bar = t.trust_score >= 80 ? '🟩' : t.trust_score >= 60 ? '🟨' : t.trust_score >= 40 ? '🟧' : '🟥';
      const catMap = { timing: '⏱️ Timing', order_dependency: '🔗 Order', shared_state: '🤝 Shared', non_deterministic_data: '🎲 Random', environment_specific: '🌐 Env' };
      const cat = catMap[t.flaky_category] || t.flaky_category || '—';
      const trendMap = { improving: '📈 Improving', degrading: '📉 Degrading', stable: '➡️ Stable' };
      const trend = trendMap[t.recent_trend] || t.recent_trend || '—';
      comment += `| \`${t.name}\` | ${bar} ${t.trust_score} | ${cat} | ${trend} |\n`;
    }

    if (flakyTests.length > 15) comment += `\n> ...and ${flakyTests.length - 15} more flaky tests\n`;
    comment += `\n`;
  }

  const reliable = (tests || []).filter(t => t.trust_score >= 90).sort((a, b) => b.trust_score - a.trust_score);
  if (reliable.length > 0) {
    comment += `### ✅ Most Reliable (Top 5)\n\n`;
    for (const t of reliable.slice(0, 5)) {
      comment += `- \`${t.name}\` — **${t.trust_score}/100** 🟢\n`;
    }
    comment += `\n`;
  }

  comment += `---\n`;
  comment += `<sub>🤖 Powered by [Falsky](https://github.com/Pritahi/falsky-test) — AI Flaky Test Trust Layer</sub>\n`;

  return comment;
}

// ─── Main ──────────────────────────────────────────────────────────
async function run() {
  try {
    const junitPath = core.getInput('junit-xml-path', { required: true });
    const apiUrl = core.getInput('api-url', { required: true }).replace(/\/$/, '');
    const apiKey = core.getInput('api-key', { required: true });
    const repoName = core.getInput('repo-name') || `${github.context.repo.owner}/${github.context.repo.repo}`;
    const failOnFlaky = core.getInput('fail-on-flaky') === 'true';
    const flakyThreshold = parseInt(core.getInput('flaky-threshold') || '50', 10);
    const commentOnPr = core.getInput('comment-on-pr') !== 'false';

    core.info(`🔬 Falsky Action — Analyzing test results...`);
    core.info(`   Repo: ${repoName}`);
    core.info(`   XML Pattern: ${junitPath}`);
    core.info(`   API: ${apiUrl}`);

    // Find XML files
    const xmlFiles = findFiles(junitPath);
    if (xmlFiles.length === 0) {
      core.setFailed(`❌ No JUnit XML files found matching: ${junitPath}`);
      return;
    }
    core.info(`📄 Found ${xmlFiles.length} XML file(s)`);

    // Parse all XML files
    let allTests = [];
    for (const file of xmlFiles) {
      core.info(`   Parsing: ${file}`);
      const xmlContent = fs.readFileSync(file, 'utf-8');
      const tests = parseJUnitXML(xmlContent);
      allTests = allTests.concat(tests);
    }
    core.info(`📊 Parsed ${allTests.length} test results`);

    // Run metadata
    const runId = `gh-${github.context.runId}-${Date.now()}`;
    const branch = github.context.ref?.replace('refs/heads/', '') || 'unknown';
    const commitSha = github.context.sha || 'unknown';
    const environment = process.env.ENVIRONMENT || 'ci';

    // Send to Falsky API
    core.info(`📤 Sending to Falsky API...`);

    let result;
    try {
      result = await httpRequest(`${apiUrl}/api/junit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Poly-API-Key': apiKey,
        },
        body: JSON.stringify({
          repo_name: repoName,
          run_id: runId,
          branch,
          commit_sha: commitSha,
          environment,
          tests: allTests,
        }),
        timeout: 30000,
      });
    } catch (err) {
      core.setFailed(`❌ API request failed: ${err.message}`);
      return;
    }

    if (result.status >= 400) {
      core.setFailed(`❌ Falsky API returned ${result.status}: ${JSON.stringify(result.data)}`);
      return;
    }

    core.info(`✅ API Response received`);

    // Fetch dashboard data
    let dashboardData = null;
    try {
      const dashRes = await httpRequest(`${apiUrl}/api/dashboard?repo=${encodeURIComponent(repoName)}`, {
        headers: { 'X-Poly-API-Key': apiKey },
        timeout: 15000,
      });
      if (dashRes.status === 200) dashboardData = dashRes.data;
    } catch {}

    const avgTrust = dashboardData?.avg_trust ?? result.data?.avg_trust ?? 0;
    const flakyCount = dashboardData?.flaky_count ?? result.data?.flaky_count ?? 0;
    const totalTests = dashboardData?.total_tests ?? allTests.length;
    const reportUrl = `${apiUrl}/dashboard/?repo=${encodeURIComponent(repoName)}`;

    core.setOutput('trust-score', avgTrust.toString());
    core.setOutput('flaky-count', flakyCount.toString());
    core.setOutput('total-tests', totalTests.toString());
    core.setOutput('report-url', reportUrl);

    core.info(`\n📊 Results:`);
    core.info(`   Trust Score: ${avgTrust}/100`);
    core.info(`   Total Tests: ${totalTests}`);
    core.info(`   Flaky Tests: ${flakyCount}`);
    core.info(`   Report: ${reportUrl}`);

    // Post PR comment
    if (commentOnPr && github.context.issue?.number) {
      core.info(`💬 Posting PR comment...`);

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        core.warning('GITHUB_TOKEN not set — skipping PR comment');
      } else {
        const octokit = github.getOctokit(token);
        const commentBody = buildComment({
          repo_name: repoName,
          total_tests: totalTests,
          avg_trust: avgTrust,
          flaky_count: flakyCount,
          quarantined: dashboardData?.quarantined_count || 0,
          tests: dashboardData?.tests || [],
          run_id: runId,
        });

        try {
          const { data: comments } = await octokit.rest.issues.listComments({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: github.context.issue.number,
          });

          const existing = comments.find(c => c.body?.includes('Falsky Trust Report'));

          if (existing) {
            await octokit.rest.issues.updateComment({
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              comment_id: existing.id,
              body: commentBody,
            });
            core.info(`   Updated existing comment #${existing.id}`);
          } else {
            await octokit.rest.issues.createComment({
              owner: github.context.repo.owner,
              repo: github.context.repo.repo,
              issue_number: github.context.issue.number,
              body: commentBody,
            });
            core.info(`   Created new PR comment`);
          }
        } catch (err) {
          core.warning(`Failed to post PR comment: ${err.message}`);
        }
      }
    } else if (commentOnPr) {
      core.info('Not a PR context — skipping comment');
    }

    if (failOnFlaky && flakyCount > 0) {
      core.setFailed(`🚨 ${flakyCount} flaky test(s) detected (threshold: ${flakyThreshold})`);
    }

  } catch (error) {
    core.setFailed(`❌ Falsky Action failed: ${error.message}`);
  }
}

run();
