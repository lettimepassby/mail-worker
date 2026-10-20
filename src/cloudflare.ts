/** Minimal Cloudflare API client for Email Routing onboarding. */

const API = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Zone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
}

export interface RoutingSettings {
  enabled: boolean;
  status: string;
  name: string;
}

export interface RuleAction {
  type: 'forward' | 'worker' | 'drop';
  value?: string[];
}

export interface RuleMatcher {
  type: 'literal' | 'all';
  field?: 'to';
  value?: string;
}

export interface RoutingRule {
  id?: string;
  tag?: string;
  name: string;
  enabled: boolean;
  priority?: number;
  matchers: RuleMatcher[];
  actions: RuleAction[];
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number };
}

export class Cloudflare {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
    const res = await fetch(API + path, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
    });
    const body = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!body?.success) {
      const detail = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
      throw new CloudflareError(detail, res.status);
    }
    return body;
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await this.request<T[]>(`${path}${sep}page=${page}&per_page=50`);
      out.push(...body.result);
      if (!body.result_info || page >= body.result_info.total_pages) return out;
    }
  }

  listZones(): Promise<Zone[]> {
    return this.all<Zone>('/zones');
  }

  async getZone(zoneId: string): Promise<Zone> {
    return (await this.request<Zone>(`/zones/${zoneId}`)).result;
  }

  async getRouting(zoneId: string): Promise<RoutingSettings> {
    return (await this.request<RoutingSettings>(`/zones/${zoneId}/email/routing`)).result;
  }

  /** Turns Email Routing on and adds/locks the MX + SPF records. */
  async enableRouting(zoneId: string): Promise<void> {
    try {
      await this.request(`/zones/${zoneId}/email/routing/dns`, { method: 'POST', body: '{}' });
    } catch (err) {
      // Older endpoint, still accepted by some accounts.
      if (err instanceof CloudflareError && (err.status === 404 || err.status === 405)) {
        await this.request(`/zones/${zoneId}/email/routing/enable`, { method: 'POST', body: '{}' });
      } else throw err;
    }
  }

  async getCatchAll(zoneId: string): Promise<RoutingRule> {
    return (await this.request<RoutingRule>(`/zones/${zoneId}/email/routing/rules/catch_all`)).result;
  }

  async setCatchAllToWorker(zoneId: string, worker: string): Promise<void> {
    await this.request(`/zones/${zoneId}/email/routing/rules/catch_all`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'mail-worker catch-all',
        enabled: true,
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [worker] }],
      }),
    });
  }

  listRules(zoneId: string): Promise<RoutingRule[]> {
    return this.all<RoutingRule>(`/zones/${zoneId}/email/routing/rules`);
  }

  async updateRule(zoneId: string, rule: RoutingRule): Promise<void> {
    const id = rule.id ?? rule.tag;
    await this.request(`/zones/${zoneId}/email/routing/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        matchers: rule.matchers,
        actions: rule.actions,
      }),
    });
  }
}

export function ruleId(rule: RoutingRule): string {
  return rule.id ?? rule.tag ?? '';
}

/** The literal address a rule matches, if it is a simple single-address rule. */
export function ruleAddress(rule: RoutingRule): string | null {
  const m = rule.matchers.find((x) => x.type === 'literal' && x.field === 'to');
  return m?.value?.toLowerCase() ?? null;
}

export function isWorkerAction(rule: RoutingRule, worker: string): boolean {
  return rule.actions.some((a) => a.type === 'worker' && a.value?.includes(worker));
}

export function forwardTargets(rule: RoutingRule): string[] {
  return rule.actions.filter((a) => a.type === 'forward').flatMap((a) => a.value ?? []);
}
