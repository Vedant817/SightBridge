import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@sightbridge/shared'],
  output: 'standalone',
};

export default nextConfig;
