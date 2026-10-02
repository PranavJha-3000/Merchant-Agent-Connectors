import type { ProviderModule } from '../core/registry.ts';
import { freshdeskModule } from './freshdesk/manifest.ts';

/**
 * The ONLY file that knows about concrete providers.
 * Adding a provider: create src/providers/<id>/manifest.ts exporting a
 * ProviderModule, then add one line here. Never edit other providers.
 */
export const providerModules: readonly ProviderModule[] = [freshdeskModule];
