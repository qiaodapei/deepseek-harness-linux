export default {
  appId: 'com.deepseek.harness.desktop',
  productName: 'DeepSeek Harness',
  copyright: 'DeepSeek Harness local build',
  directories: {
    output: 'dist-desktop',
    buildResources: 'desktop/build',
  },
  files: [
    'desktop/main.mjs',
    'desktop/splash.html',
    'desktop/assets/**/*',
    'package.json',
    '!node_modules/**/*',
  ],
  asar: true,
  asarUnpack: ['desktop/assets/**/*', 'desktop/splash.html'],
  extraResources: [{ from: 'runtime', to: 'runtime' }],
  npmRebuild: false,
  buildDependenciesFromSource: false,
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Development',
    executableName: 'deepseek-harness',
    icon: 'desktop/assets/icon-512.png',
    synopsis: 'DeepSeek Harness desktop client',
    description: 'DeepSeek Harness desktop client with a bundled dsh runtime',
    executableArgs: ['--no-sandbox'],
    syncDesktopName: true,
    desktop: {
      entry: {
        Name: 'DeepSeek Harness',
        Comment: 'DeepSeek Harness desktop client',
        Keywords: 'deepseek;harness;dsh;ai;agent;',
        StartupNotify: 'true',
      },
    },
  },
  appImage: {
    artifactName: 'DeepSeek-Harness-${version}-${arch}.AppImage',
    compression: 'gzip',
  },
}
