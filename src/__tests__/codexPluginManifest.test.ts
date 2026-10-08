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
});
