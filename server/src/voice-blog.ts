import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const ATJ_ROOT = process.env.WORKSPACE_ROOT || process.cwd();

interface VoiceMemoResult {
  success: boolean;
  filename: string;
  title: string;
  cluster: string;
  error?: string;
}

function loadClusterRegistry(): Record<string, unknown> {
  const registryPath = path.join(ATJ_ROOT, 'cluster_registry.json');
  return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function processVoiceMemo(transcript: string): Promise<VoiceMemoResult> {
  if (!transcript || transcript.trim().length < 10) {
    return { success: false, filename: '', title: '', cluster: '', error: 'Transcript too short (min 10 chars)' };
  }

  try {
    const registry = loadClusterRegistry();
    const clusters = registry.clusters as Record<string, { display_name: string; saturation_status: string; post_count: number }>;
    const audience = registry.target_audience as { description: string; pain_points: string[] };

    // Build cluster summary for the prompt
    const clusterSummary = Object.entries(clusters).map(([key, c]) => {
      return `- ${key} (${c.display_name}) — ${c.post_count} posts, ${c.saturation_status}`;
    }).join('\n');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are a blog topic planner for ATJ Digital, a marketing automation agency targeting local service business owners (HVAC, dental, medspa, coaching, plumbing, roofing, etc.).

TARGET AUDIENCE: ${audience.description}
PAIN POINTS: ${audience.pain_points.join(', ')}

EXISTING CLUSTERS (prefer "starved" clusters when the topic fits):
${clusterSummary}

A user just dictated this voice memo about a blog topic idea:

---
${transcript.trim()}
---

Based on this voice memo, generate a blog topic plan. Return ONLY valid JSON with these fields:
{
  "title": "SEO-optimized blog post title (include GoHighLevel or GHL if relevant)",
  "cluster_key": "best matching cluster key from the list above, or 'unclustered' if none fit",
  "priority": "high" or "normal" or "low",
  "type": "general",
  "references": ["https://automatethejourney.com/relevant-page-1", "https://automatethejourney.com/relevant-page-2"],
  "notes": "2-3 paragraph topic brief including: target cluster rationale, angle, what to cover (bulleted list), industry examples, CTA suggestions",
  "keywords": "comma-separated SEO keywords (5-8 keywords)"
}

Return ONLY the JSON object, no markdown fences, no explanation.`
      }]
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Parse JSON from response (handle potential markdown fences)
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const plan = JSON.parse(jsonStr);

    // Build the .md file content
    const refsYaml = (plan.references || []).map((r: string) => `  - "${r}"`).join('\n');
    const mdContent = `---
topic: "${plan.title}"
type: ${plan.type || 'general'}
priority: ${plan.priority || 'normal'}
rewrite_url: ""
references:
${refsYaml || '  []'}
---

${plan.notes}

Keywords: ${plan.keywords}
`;

    // Write to topics/ folder
    const topicsDir = path.join(ATJ_ROOT, 'topics');
    if (!fs.existsSync(topicsDir)) {
      fs.mkdirSync(topicsDir, { recursive: true });
    }

    let filename = slugify(plan.title) + '.md';
    const fullPath = path.join(topicsDir, filename);

    // Handle duplicate filenames
    if (fs.existsSync(fullPath)) {
      filename = slugify(plan.title) + '-' + Date.now() + '.md';
    }

    fs.writeFileSync(path.join(topicsDir, filename), mdContent, 'utf-8');
    console.log(`Voice memo → topic file: ${filename} (cluster: ${plan.cluster_key})`);

    return {
      success: true,
      filename,
      title: plan.title,
      cluster: plan.cluster_key,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Voice memo processing failed:', message);
    return { success: false, filename: '', title: '', cluster: '', error: message };
  }
}
