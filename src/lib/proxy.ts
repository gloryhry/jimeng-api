import axios from "axios";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import logger from "@/lib/logger.ts";

type Agents = { httpAgent: any; httpsAgent: any };

const agentCache = new Map<string, Agents>();

function getEnv(name: string): string | undefined {
  return process.env[name] || process.env[name.toLowerCase()];
}

function getProxyUrlFor(protocol: "http" | "https"): string | undefined {
  const all = getEnv("ALL_PROXY") || getEnv("ALLPROXY");
  if (protocol === "http") {
    return getEnv("HTTP_PROXY") || all;
  }
  return getEnv("HTTPS_PROXY") || all;
}

function createAgents(proxyUrl: string): Agents {
  if (agentCache.has(proxyUrl)) return agentCache.get(proxyUrl)!;
  const scheme = (() => {
    try {
      return new URL(proxyUrl).protocol.replace(":", "");
    } catch {
      // 默认补全为 http
      return "http";
    }
  })();

  let httpAgent: any;
  let httpsAgent: any;

  if (/^socks/i.test(scheme)) {
    const agent = new SocksProxyAgent(proxyUrl);
    httpAgent = agent;
    httpsAgent = agent;
  } else {
    // http/https 代理
    httpAgent = new HttpProxyAgent(proxyUrl);
    httpsAgent = new HttpsProxyAgent(proxyUrl);
  }

  const agents = { httpAgent, httpsAgent };
  agentCache.set(proxyUrl, agents);
  return agents;
}

function parseNoProxy(): string[] {
  const noProxy = getEnv("NO_PROXY") || "";
  return noProxy
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostnameWithPort(u: URL): { host: string; port?: number } {
  const host = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : undefined;
  return { host, port };
}

function isBypassed(urlStr: string, noProxyList: string[]): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false; // 相对地址无法判断，默认不绕过
  }
  const { host, port } = hostnameWithPort(u);

  if (!noProxyList.length) return false;
  if (noProxyList.includes("*")) return true;

  for (const entry of noProxyList) {
    const [h, p] = entry.split(":").map((s) => s.trim()).filter(Boolean);
    if (p && port && parseInt(p, 10) !== port) continue;
    // 完全匹配或后缀匹配
    if (h === host) return true;
    if (host.endsWith(h.startsWith(".") ? h : `.${h}`)) return true;
  }
  return false;
}

export function setupGlobalProxy() {
  const httpProxyUrl = getProxyUrlFor("http");
  const httpsProxyUrl = getProxyUrlFor("https");
  const noProxyList = parseNoProxy();

  if (!httpProxyUrl && !httpsProxyUrl) {
    logger.info("未检测到代理环境变量，网络请求将直连");
    return;
  }

  // 在拦截器中按目标协议与 NO_PROXY 决定是否使用代理
  axios.defaults.proxy = false; // 始终通过自定义 Agent 处理

  axios.interceptors.request.use((config) => {
    try {
      // 解析绝对 URL（优先合成 baseURL + url）
      const absoluteUrl = (() => {
        if (config.url && /^(http|https):\/\//i.test(config.url)) return config.url;
        if (config.baseURL && config.url) return new URL(config.url, config.baseURL).toString();
        return config.url || "";
      })();

      if (!absoluteUrl) return config;

      if (isBypassed(absoluteUrl, noProxyList)) {
        return config; // 命中 NO_PROXY，直接绕过
      }

      const protocol = new URL(absoluteUrl).protocol.replace(":", "");
      let proxyUrlToUse: string | undefined;
      if (protocol === "https") proxyUrlToUse = httpsProxyUrl || httpProxyUrl;
      else proxyUrlToUse = httpProxyUrl || httpsProxyUrl;

      if (!proxyUrlToUse) return config;

      const { httpAgent, httpsAgent } = createAgents(proxyUrlToUse);
      // 若调用方未显式指定，则注入代理 Agent
      config.proxy = false;
      if (!config.httpAgent) config.httpAgent = httpAgent;
      if (!config.httpsAgent) config.httpsAgent = httpsAgent;
    } catch (e) {
      // 失败时不阻断请求
    }
    return config;
  });

  const mask = (url?: string) => (url ? url.replace(/([^:\/]{2}).+@/, "$1***@") : "");
  logger.info(
    `已启用代理: http=${mask(httpProxyUrl)} https=${mask(httpsProxyUrl)}${
      noProxyList.length ? ` no_proxy=[${noProxyList.join(", ")}]` : ""
    }`
  );
}

