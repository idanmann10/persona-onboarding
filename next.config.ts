import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The souls and the company memory are Markdown read at runtime (lib/agent): ship them with every server route.
  outputFileTracingIncludes: { '/**': ['./lib/agent/soul/*.md', './lib/agent/company/*.md'] },
};

export default nextConfig;
