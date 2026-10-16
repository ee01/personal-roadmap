import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Codex plugin manifest', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'plugin/.codex-plugin/plugin.json'), 'utf8'),
  ) as {
    name: string;
    version: string;
    interface: {
      displayName: string;
      shortDescription: string;
      longDescription: string;
      defaultPrompt: string[];
    };
    skills: string[];
  };

  it('is mentioned as Personal Roadmap', () => {
    expect(manifest.name).toBe('roadmap-planning');
    expect(manifest.interface.displayName).toBe('Personal Roadmap');
    expect(manifest.interface.displayName.length).toBeLessThanOrEqual(30);
    expect(manifest.interface.shortDescription.length).toBeLessThanOrEqual(30);
    expect(manifest.interface.longDescription).toContain('@');
    expect(manifest.interface.longDescription).toContain('Personal Roadmap');
  });

  it('ships starter prompts Codex can show after install', () => {
    const prompts = manifest.interface.defaultPrompt;
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.length).toBeLessThanOrEqual(3);
    for (const prompt of prompts) {
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt.length).toBeLessThanOrEqual(128);
      expect(prompt).not.toContain('@');
    }
  });

  it('names the bundled skill Personal Roadmap in Codex skill metadata', () => {
    const skillUi = readFileSync(
      path.join(root, 'plugin/skills/roadmap-planning/agents/openai.yaml'),
      'utf8',
    );
    expect(skillUi).toContain('display_name: "Personal Roadmap"');
  });

  it('ships Roadmap Setup and gates planning until a team token is stored', () => {
    expect(manifest.version).toBe('1.2.1');
    expect(manifest.skills).toEqual(['skills/roadmap-planning', 'skills/roadmap-setup']);
    expect(manifest.interface.longDescription).toContain('Roadmap Setup');
    const setupUi = readFileSync(
      path.join(root, 'plugin/skills/roadmap-setup/agents/openai.yaml'),
      'utf8',
    );
    expect(setupUi).toContain('display_name: "Roadmap Setup"');
    const setupSkill = readFileSync(
      path.join(root, 'plugin/skills/roadmap-setup/SKILL.md'),
      'utf8',
    );
    expect(setupSkill).toContain('name: roadmap-setup');
    expect(setupSkill).toContain('不要在回复里复述 token');
    const planning = readFileSync(
      path.join(root, 'plugin/skills/roadmap-planning/SKILL.md'),
      'utf8',
    );
    expect(planning).toContain('$roadmap-setup');
    expect(planning).toContain('不要先做用户原来的请求');
    expect(planning).toContain('只安装了这份 Skill');
    expect(planning).toContain('分享可编辑链接');
    expect(planning).toContain('不要运行 `$roadmap-setup`');
    const mcp = JSON.parse(readFileSync(path.join(root, 'plugin/.mcp.json'), 'utf8')) as {
      mcpServers: { 'roadmap-planning': { args: string[] } };
    };
    expect(mcp.mcpServers['roadmap-planning'].args[0]).toBe('${PLUGIN_ROOT}/scripts/mcp-bridge.mjs');
    const hooks = JSON.parse(readFileSync(path.join(root, 'plugin/hooks/hooks.json'), 'utf8')) as {
      hooks: { SessionStart: unknown[]; PreToolUse: Array<{ matcher: string }> };
    };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('roadmap_');
  });
});
