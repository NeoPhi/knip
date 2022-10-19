import path from 'node:path';
import ts from 'typescript';
import { resolveConfig, resolveIncludedIssueGroups } from './util/config';
import { findFile } from './util/fs';
import { resolvePaths } from './util/path';
import { createProject } from './util/project';
import { findIssues } from './runner';
import { ConfigurationError } from './util/errors';
import { debugLogObject, debugLogFiles, debugLogSourceFiles } from './util/debug';
import { getMessageUpdater } from './progress';
import type { UnresolvedConfiguration, Configuration, LocalConfiguration } from './types';

export const main = async (options: UnresolvedConfiguration) => {
  const {
    cwd,
    workingDir,
    configFilePath: configFilePathArg,
    tsConfigFilePath: tsConfigFilePathArg,
    include,
    exclude,
    ignore,
    gitignore,
    isIncludeEntryFiles,
    isDev,
    isShowProgress,
    jsDoc,
    debug,
  } = options;

  const updateMessage = getMessageUpdater(options);

  debugLogObject(options, 1, 'Unresolved configuration', options);

  updateMessage('Reading configuration and manifest files...');

  const manifestPath = await findFile(cwd, workingDir, 'package.json');
  const manifest = manifestPath && require(manifestPath);

  const configFilePath = configFilePathArg ?? 'knip.json';
  const resolvedConfigFilePath = await findFile(cwd, workingDir, configFilePath);
  const localConfig = resolvedConfigFilePath && require(resolvedConfigFilePath);
  if (configFilePathArg && !resolvedConfigFilePath) {
    throw new ConfigurationError(`Unable to find ${configFilePathArg}`);
  }

  const tsConfigFilePath = tsConfigFilePathArg ?? 'tsconfig.json';
  const resolvedTsConfigFilePath = await findFile(cwd, workingDir, tsConfigFilePath);
  if (tsConfigFilePathArg && !resolvedTsConfigFilePath) {
    throw new ConfigurationError(`Unable to find ${tsConfigFilePathArg}`);
  }

  let tsConfigPaths: string[] = [];
  if (resolvedTsConfigFilePath) {
    const config = ts.readConfigFile(resolvedTsConfigFilePath, ts.sys.readFile);
    tsConfigPaths = config.config.compilerOptions?.paths
      ? Object.keys(config.config.compilerOptions.paths).map(p => p.replace(/\*/g, '**')) // TODO Replacement too naive?
      : [];
    if (config.error) {
      throw new ConfigurationError(`Unable to read ${path.relative(cwd, resolvedTsConfigFilePath)}`);
    }
  }

  const dir = path.relative(cwd, workingDir);
  const resolvedConfig = resolveConfig(manifest.knip ?? localConfig, { workingDir: dir, isDev });

  debugLogObject(options, 1, 'Resolved configuration', resolvedConfig);

  if (!resolvedConfigFilePath && !manifest.knip && !resolvedTsConfigFilePath) {
    throw new ConfigurationError(`Unable to find ${configFilePath} or package.json#knip or ${tsConfigFilePath}`);
  }

  const { entryFiles, productionFiles, projectFiles } = await (async () => {
    if (resolvedConfig) {
      const skipAddFiles = { skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true };
      const projectOptions = resolvedTsConfigFilePath
        ? { tsConfigFilePath: resolvedTsConfigFilePath }
        : { compilerOptions: { allowJs: true } };

      updateMessage('Resolving entry files...');
      const entryPaths = await resolvePaths({
        cwd,
        workingDir,
        patterns: resolvedConfig.entryFiles,
        ignore,
        gitignore,
      });
      debugLogFiles(options, 1, 'Globbed entry paths', entryPaths);

      // Create workspace for entry files, but don't resolve dependencies yet
      const production = createProject({ ...projectOptions, ...skipAddFiles }, entryPaths);
      const entryFiles = production.getSourceFiles();
      debugLogSourceFiles(options, 1, 'Included entry source files', entryFiles);

      // Now resolve dependencies of entry files to find all production files
      production.resolveSourceFileDependencies();
      const productionFiles = production.getSourceFiles();
      debugLogSourceFiles(options, 1, 'Included production source files', productionFiles);

      updateMessage('Resolving project files...');
      const projectPaths = await resolvePaths({
        cwd,
        workingDir,
        patterns: resolvedConfig.projectFiles,
        ignore,
        gitignore,
      });
      debugLogFiles(options, 1, 'Globbed project paths', projectPaths);

      // Create workspace for the entire project
      const project = createProject({ ...projectOptions, ...skipAddFiles }, projectPaths);
      const projectFiles = project.getSourceFiles();
      debugLogSourceFiles(options, 1, 'Included project source files', projectFiles);

      return { entryFiles, productionFiles, projectFiles };
    } else {
      updateMessage('Resolving project files...');
      // Zero-config resolution, just pass the TS config to ts-morph
      const project = createProject({ tsConfigFilePath: resolvedTsConfigFilePath });
      const files = project.getSourceFiles();
      return { entryFiles: files, productionFiles: files, projectFiles: files };
    }
  })();

  // No (need to report) unused files in zero-config mode
  const report = resolveIncludedIssueGroups(include, resolvedConfig ? exclude : ['files'], resolvedConfig);

  const config: Configuration = {
    workingDir,
    report,
    entryFiles,
    productionFiles,
    projectFiles,
    isIncludeEntryFiles: !resolvedConfig || isIncludeEntryFiles,
    dependencies: Object.keys(manifest.dependencies ?? {}),
    peerDependencies: Object.keys(manifest.peerDependencies ?? {}),
    optionalDependencies: Object.keys(manifest.optionalDependencies ?? {}),
    devDependencies: Object.keys(manifest.devDependencies ?? {}),
    isDev: typeof resolvedConfig?.dev === 'boolean' ? resolvedConfig.dev : isDev,
    tsConfigPaths,
    isShowProgress,
    jsDocOptions: {
      isReadPublicTag: jsDoc.includes('public'),
    },
    debug,
  };

  const { issues, counters } = await findIssues(config);

  debugLogObject(options, 2, 'Issues', issues);

  return { report, issues, counters };
};
