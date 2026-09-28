import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The agents' souls are Markdown read at runtime (lib/agent/soul): ship them with every server route.
  outputFileTracingIncludes: { '/**': ['./lib/agent/soul/*.md'] },
};

export default nextConfig;
