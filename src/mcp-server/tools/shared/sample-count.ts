/** Shared request validation and served cap for profile and sightline sampling. */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { blankAsUnset } from '@/mcp-server/tools/shared/inputs.js';

export const MAX_SAMPLES = 250;
const MAX_REQUESTED_SAMPLES = 1_000;
type SampleCountTool = 'elevation_get_profile' | 'elevation_check_line_of_sight';

const sampleCountClamps = createCounter(
  'elevation.sample_count_clamps',
  'Requests with a clamped terrain sample count',
  '{clamps}',
);

/** Advertises the served cap while accepting larger requests unless strict mode is enabled. */
export function sampleCountInput(minimum: number, tool: SampleCountTool) {
  const count = z
    .number()
    .int()
    .min(minimum)
    .max(MAX_REQUESTED_SAMPLES)
    .superRefine((value, ctx) => {
      if (value > MAX_SAMPLES && !getServerConfig().clampLimits) {
        ctx.addIssue({ code: 'too_big', origin: 'number', maximum: MAX_SAMPLES, inclusive: true });
      }
    })
    .meta({ maximum: MAX_SAMPLES })
    .default(100);
  return blankAsUnset(count, { kind: 'number', tool, field: 'samples' });
}

/** Caps a validated request before resampling and returns any clamp disclosure. */
export function clampSampleCount(
  requested: number,
  tool: SampleCountTool,
  ctx: Pick<Context, 'log'>,
) {
  if (requested <= MAX_SAMPLES) return { count: requested };

  const labels = { tool, field: 'samples' };
  sampleCountClamps.add(1, labels);
  ctx.log.info('Clamped terrain sample count', {
    ...labels,
    requested,
    effective: MAX_SAMPLES,
  });
  return {
    count: MAX_SAMPLES,
    notice: `Samples clamped from ${requested} to the ${MAX_SAMPLES}-sample cap.`,
  };
}
