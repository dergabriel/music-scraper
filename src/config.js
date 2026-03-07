import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

const StationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  playlist_url: z.string().min(1),
  fallback_urls: z.array(z.string().min(1)).optional().default([]),
  parser: z.enum(['dlf_nova', 'fluxfm', 'onlineradiobox', 'generic_html_or_onlineradiobox', 'generic_html', 'nrwlokalradios_json', 'radiomenu']),
  fetcher: z.enum(['http', 'playwright']).default('http'),
  timezone: z.string().min(1).default('Europe/Berlin'),
  enforce_one_play_per_minute: z.boolean().optional().default(false),
  min_play_gap_seconds: z.number().int().min(0).optional().default(0),
  min_daily_hours: z.number().int().min(1).max(24).optional().default(20),
  min_daily_plays: z.number().int().min(0).optional().default(24)
});

const ConfigSchema = z.object({
  stations: z.array(StationSchema).min(1)
});

export function loadConfig(configPath) {
  const resolvedPath = path.resolve(configPath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = yaml.load(raw);
  return ConfigSchema.parse(parsed);
}
