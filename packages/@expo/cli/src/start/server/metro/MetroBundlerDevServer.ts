/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { getConfig } from '@expo/config';
import { prependMiddleware } from '@expo/dev-server';
import { ExpoResponse, installGlobals } from '@expo/server/build/environment';
import { convertRequest, respond } from '@expo/server/build/vendor/http';
import assert from 'assert';
import chalk from 'chalk';
import { sync as globSync } from 'glob';
import path from 'path';
import requireString from 'require-from-string';
import resolve from 'resolve';
import resolveFrom from 'resolve-from';
import { promisify } from 'util';

import { Log } from '../../../log';
import getDevClientProperties from '../../../utils/analytics/getDevClientProperties';
import { logEventAsync } from '../../../utils/analytics/rudderstackClient';
import { env } from '../../../utils/env';
import { getFreePortAsync } from '../../../utils/port';
import { BundlerDevServer, BundlerStartOptions, DevServerInstance } from '../BundlerDevServer';
import {
  getStaticPageContentsAsync,
  getStaticRenderFunctions,
  requireFileContentsWithMetro,
  requireWithMetro,
} from '../getStaticRenderFunctions';
import { CreateFileMiddleware } from '../middleware/CreateFileMiddleware';
import { HistoryFallbackMiddleware } from '../middleware/HistoryFallbackMiddleware';
import { InterstitialPageMiddleware } from '../middleware/InterstitialPageMiddleware';
import { ReactDevToolsPageMiddleware } from '../middleware/ReactDevToolsPageMiddleware';
import {
  DeepLinkHandler,
  RuntimeRedirectMiddleware,
} from '../middleware/RuntimeRedirectMiddleware';
import { ServeStaticMiddleware } from '../middleware/ServeStaticMiddleware';
import { ServerNext, ServerRequest, ServerResponse } from '../middleware/server.types';
import { instantiateMetroAsync } from './instantiateMetro';
import {
  observeApiRouteChanges,
  waitForMetroToObserveTypeScriptFile,
} from './waitForMetroToObserveTypeScriptFile';

const resolveAsync = promisify(resolve) as any as (
  id: string,
  opts: resolve.AsyncOpts
) => Promise<string | null>;

const debug = require('debug')('expo:start:server:metro') as typeof console.log;

/** Default port to use for apps running in Expo Go. */
const EXPO_GO_METRO_PORT = 19000;

/** Default port to use for apps that run in standard React Native projects or Expo Dev Clients. */
const DEV_CLIENT_METRO_PORT = 8081;

async function getExpoRouteManifestBuilderAsync(
  projectRoot: string,
  {
    devServerUrl,
    minify,
    dev,
  }: {
    devServerUrl: string;
    minify: boolean;
    dev: boolean;
  }
) {
  const matchNodePath = path.join(
    resolveFrom(projectRoot, 'expo-router/package.json'),
    '../routes-manifest.ts'
  );
  const { createRoutesManifest } = await requireWithMetro<{
    createRoutesManifest: () => any;
  }>(projectRoot, devServerUrl, matchNodePath, {
    minify,
    dev,
  });
  return createRoutesManifest;
}

export async function exportRouteHandlersAsync(
  projectRoot: string,
  options: { mode?: string; port?: number }
) {
  const devServerUrl = `http://localhost:${options.port}`;

  const appDir = path.join(
    projectRoot,
    // TODO: Support other directories via app.json
    'app'
  );

  function getRouteFiles() {
    // TODO: Cache this
    return globSync('**/*+api.@(ts|tsx|js|jsx)', {
      cwd: appDir,
      absolute: true,
    });
  }

  const files = getRouteFiles();

  const output: Record<string, string> = {};

  const getManifest = await getExpoRouteManifestBuilderAsync(projectRoot, {
    devServerUrl,
    minify: options.mode === 'production',
    dev: options.mode !== 'production',
  });

  for (const file of files) {
    console.log('file', devServerUrl, file);
    const middleware = await requireFileContentsWithMetro(projectRoot, devServerUrl, file, {
      minify: options.mode === 'production',
      dev: options.mode !== 'production',
    });
    output[path.relative(appDir, file)] = middleware;
  }

  const manifest = getManifest();

  return [manifest, output];
}

const manifestOperation = new Map<string, Promise<any>>();

async function refetchManifest(projectRoot: string, options: { mode?: string; port?: number }) {
  manifestOperation.delete('manifest');
  return fetchManifest(projectRoot, options);
}

async function fetchManifest(projectRoot: string, options: { mode?: string; port?: number }) {
  if (manifestOperation.has('manifest')) {
    return manifestOperation.get('manifest');
  }

  const devServerUrl = `http://localhost:${options.port}`;

  async function bundleAsync() {
    // TODO: Update eagerly when files change
    const getManifest = await getExpoRouteManifestBuilderAsync(projectRoot, {
      devServerUrl,
      minify: options.mode === 'production',
      dev: options.mode !== 'production',
    });

    const manifest = getManifest().map((value: any) => {
      return {
        ...value,
        regex: new RegExp(value.regex),
      };
    });
    console.log('manifest', manifest);
    return manifest;
  }

  manifestOperation.set('manifest', bundleAsync());
}

const pendingRouteOperations = new Map<string, Promise<string>>();

async function rebundleApiRoute(
  projectRoot: string,
  filepath: string,
  options: { mode?: string; port?: number }
) {
  pendingRouteOperations.delete(filepath);
  return bundleApiRoute(projectRoot, filepath, options);
}
async function bundleApiRoute(
  projectRoot: string,
  filepath: string,
  options: { mode?: string; port?: number }
) {
  if (pendingRouteOperations.has(filepath)) {
    return pendingRouteOperations.get(filepath);
  }

  const devServerUrl = `http://localhost:${options.port}`;

  async function bundleAsync() {
    try {
      debug('Check API route:', path.join(projectRoot, 'app'), filepath);

      const middleware = await requireFileContentsWithMetro(projectRoot, devServerUrl, filepath, {
        minify: options.mode === 'production',
        dev: options.mode !== 'production',
        // Ensure Node.js
        environment: 'node',
      });

      return middleware;
    } finally {
      // pendingRouteOperations.delete(filepath);
    }
  }

  pendingRouteOperations.set(filepath, bundleAsync());
}

async function eagerBundleApiRoutes(
  projectRoot: string,
  options: { mode?: string; port?: number }
) {
  const appDir = path.join(
    projectRoot,
    // TODO: Support other directories via app.json
    'app'
  );

  const routes = globSync('**/*+api.@(ts|tsx|js|jsx)', {
    cwd: appDir,
    absolute: true,
  });

  const promises = routes.map(async (filepath) => bundleApiRoute(projectRoot, filepath, options));

  await Promise.all(promises);
}
function createRouteHandlerMiddleware(
  projectRoot: string,
  options: { mode?: string; port?: number; getWebBundleUrl: () => string }
) {
  // don't await
  eagerBundleApiRoutes(projectRoot, options);
  refetchManifest(projectRoot, options);

  const devServerUrl = `http://localhost:${options.port}`;

  const appDir = path.join(
    projectRoot,
    // TODO: Support other directories via app.json
    'app'
  );
  // function getRouteFiles() {
  //   // TODO: Cache this
  //   return globSync('**/*+api.@(ts|tsx|js|jsx)', {
  //     cwd: appDir,
  //     absolute: false,
  //   }).map((path) => './' + path);
  // }

  return async (req: ServerRequest, res: ServerResponse, next: ServerNext) => {
    if (!req?.url || !req.method) {
      return next();
    }

    const location = new URL(req.url, 'https://example.dev');

    // 1. Get pathname, e.g. `/thing`
    const pathname = location.pathname?.replace(/\/$/, '');

    const manifest = await fetchManifest(projectRoot, options);

    const sanitizedPathname = pathname.replace(/^\/+/, '').replace(/\/+$/, '') + '/';

    let functionFilePath: string | null = null;

    const staticManifest = manifest.filter((route) => route.type === 'static');
    const dynamicManifest = manifest.filter((route) => route.type === 'dynamic');

    for (const route of dynamicManifest) {
      if (route.regex.test(sanitizedPathname)) {
        functionFilePath = route.file;
        break;
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      for (const route of staticManifest) {
        if (route.regex.test(sanitizedPathname)) {
          if (
            // Skip the 404 page if there's a function
            route.generated &&
            route.file.match(/^\.\/\[\.\.\.404]\.[jt]sx?$/)
          ) {
            if (functionFilePath) {
              continue;
            }
          }

          console.log('Using:', route.src, sanitizedPathname, route.regex);
          try {
            const { getStaticContent } = await getStaticRenderFunctions(projectRoot, devServerUrl, {
              minify: options.mode === 'production',
              dev: options.mode !== 'production',
            });

            let content = await getStaticContent(location);

            //TODO: Not this -- disable injection some other way
            if (options.mode !== 'production') {
              // Add scripts for rehydration
              // TODO: bundle split
              content = content.replace(
                '</body>',
                [`<script src="${options.getWebBundleUrl()}" defer></script>`].join('\n') +
                  '</body>'
              );
            }

            res.setHeader('Content-Type', 'text/html');
            res.end(content);
            return;
          } catch (error: any) {
            console.error(error);
            res.setHeader('Content-Type', 'text/html');
            res.end(getErrorResult(error));
          }
          return;
        }
      }
    }

    if (!functionFilePath) {
      return next();
    }
    functionFilePath = await resolveAsync(functionFilePath, {
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
      basedir: appDir,
    })!;

    const middlewareContents = await bundleApiRoute(projectRoot, functionFilePath!, options);
    if (!middlewareContents) {
      return next();
    }

    const middleware = requireString(middlewareContents);

    debug(`Supported methods (API route exports):`, Object.keys(middleware), ' -> ', req.method);

    // Interop default
    const func = middleware[req.method];

    if (!func) {
      res.statusCode = 405;
      return res.end('Method not allowed');
    }

    const expoRequest = convertRequest(req, res);

    try {
      // 4. Execute.
      const response = (await func?.(expoRequest)) as ExpoResponse;

      // 5. Respond
      if (response) {
        await respond(res, response);
      } else {
        // TODO: Not sure what to do here yet
        res.statusCode = 500;
        res.end();
      }
    } catch (error) {
      // TODO: Symbolicate error stack
      console.error(error);
      res.statusCode = 500;
      res.end();
    }
  };
}

export class MetroBundlerDevServer extends BundlerDevServer {
  private metro: import('metro').Server | null = null;

  get name(): string {
    return 'metro';
  }

  async resolvePortAsync(options: Partial<BundlerStartOptions> = {}): Promise<number> {
    const port =
      // If the manually defined port is busy then an error should be thrown...
      options.port ??
      // Otherwise use the default port based on the runtime target.
      (options.devClient
        ? // Don't check if the port is busy if we're using the dev client since most clients are hardcoded to 8081.
          Number(process.env.RCT_METRO_PORT) || DEV_CLIENT_METRO_PORT
        : // Otherwise (running in Expo Go) use a free port that falls back on the classic 19000 port.
          await getFreePortAsync(EXPO_GO_METRO_PORT));

    return port;
  }

  /** Get routes from Expo Router. */
  async getRoutesAsync() {
    const url = this.getDevServerUrl();
    assert(url, 'Dev server must be started');
    const { getManifest } = await getStaticRenderFunctions(this.projectRoot, url);
    return getManifest({ preserveApiRoutes: false });
  }

  async getFunctionsAsync({ mode }: { mode: 'development' | 'production' }) {
    return await exportRouteHandlersAsync(this.projectRoot, {
      port: this.getInstance()?.location.port,
      mode,
    });
  }

  async getStaticPageAsync(
    pathname: string,
    {
      mode,
    }: {
      mode: 'development' | 'production';
    }
  ) {
    const location = new URL(pathname, 'https://example.dev');

    const load = await getStaticPageContentsAsync(this.projectRoot, this.getDevServerUrl()!, {
      minify: mode === 'production',
      dev: mode !== 'production',
    });

    return await load(location);
  }

  protected async startImplementationAsync(
    options: BundlerStartOptions
  ): Promise<DevServerInstance> {
    options.port = await this.resolvePortAsync(options);
    this.urlCreator = this.getUrlCreator(options);

    const parsedOptions = {
      port: options.port,
      maxWorkers: options.maxWorkers,
      resetCache: options.resetDevServer,

      // Use the unversioned metro config.
      // TODO: Deprecate this property when expo-cli goes away.
      unversioned: false,
    };

    const { metro, server, middleware, messageSocket } = await instantiateMetroAsync(
      this.projectRoot,
      parsedOptions
    );

    const manifestMiddleware = await this.getManifestMiddlewareAsync(options);

    // We need the manifest handler to be the first middleware to run so our
    // routes take precedence over static files. For example, the manifest is
    // served from '/' and if the user has an index.html file in their project
    // then the manifest handler will never run, the static middleware will run
    // and serve index.html instead of the manifest.
    // https://github.com/expo/expo/issues/13114

    prependMiddleware(middleware, manifestMiddleware.getHandler());

    middleware.use(
      new InterstitialPageMiddleware(this.projectRoot, {
        // TODO: Prevent this from becoming stale.
        scheme: options.location.scheme ?? null,
      }).getHandler()
    );
    middleware.use(new ReactDevToolsPageMiddleware(this.projectRoot).getHandler());

    const deepLinkMiddleware = new RuntimeRedirectMiddleware(this.projectRoot, {
      onDeepLink: getDeepLinkHandler(this.projectRoot),
      getLocation: ({ runtime }) => {
        if (runtime === 'custom') {
          return this.urlCreator?.constructDevClientUrl();
        } else {
          return this.urlCreator?.constructUrl({
            scheme: 'exp',
          });
        }
      },
    });
    middleware.use(deepLinkMiddleware.getHandler());

    middleware.use(new CreateFileMiddleware(this.projectRoot).getHandler());

    // Append support for redirecting unhandled requests to the index.html page on web.
    if (this.isTargetingWeb()) {
      // This MUST be after the manifest middleware so it doesn't have a chance to serve the template `public/index.html`.
      middleware.use(new ServeStaticMiddleware(this.projectRoot).getHandler());
    }

    if (env.EXPO_USE_ROUTE_HANDLERS) {
      // Ensure the global environment is configured as expected.
      // TODO: Inject this side-effect using Metro to ensure it's available in production bundles.
      installGlobals();

      // Middleware for hosting middleware
      middleware.use(
        createRouteHandlerMiddleware(this.projectRoot, {
          ...options,
          getWebBundleUrl: manifestMiddleware.getWebBundleUrl.bind(manifestMiddleware),
        })
      );

      observeApiRouteChanges(
        this.projectRoot,
        {
          metro,
          server,
        },
        async (filepath, op) => {
          const isApiRoute = filepath.match(/\+api\.[tj]sx?$/);
          if (op === 'delete') {
            // update manifest
            console.log('update manifest');
            await refetchManifest(this.projectRoot, options);
          } else if (op === 'add' || (op === 'change' && !isApiRoute)) {
            console.log('invalidate manifest');
            // The manifest won't be fresh instantly so we should just clear it to ensure the next request will get the latest.
            manifestOperation.delete('manifest');
          }

          if (isApiRoute) {
            console.log(`[expo-cli] ${op} ${filepath}`);
            if (op === 'change' || op === 'add') {
              rebundleApiRoute(this.projectRoot, filepath, options);
            }

            if (op === 'delete') {
              // TODO: Cancel the bundling of the deleted route.
            }
          }
        }
      );
    }

    if (this.isTargetingWeb()) {
      // This MUST run last since it's the fallback.
      if (!env.EXPO_USE_STATIC) {
        middleware.use(
          new HistoryFallbackMiddleware(manifestMiddleware.getHandler().internal).getHandler()
        );
      }
    }
    // Extend the close method to ensure that we clean up the local info.
    const originalClose = server.close.bind(server);

    server.close = (callback?: (err?: Error) => void) => {
      return originalClose((err?: Error) => {
        this.instance = null;
        this.metro = null;
        callback?.(err);
      });
    };

    this.metro = metro;
    return {
      server,
      location: {
        // The port is the main thing we want to send back.
        port: options.port,
        // localhost isn't always correct.
        host: 'localhost',
        // http is the only supported protocol on native.
        url: `http://localhost:${options.port}`,
        protocol: 'http',
      },
      middleware,
      messageSocket,
    };
  }

  public async waitForTypeScriptAsync(): Promise<void> {
    if (!this.instance) {
      throw new Error('Cannot wait for TypeScript without a running server.');
    }
    if (!this.metro) {
      // This can happen when the run command is used and the server is already running in another
      // process. In this case we can't wait for the TypeScript check to complete because we don't
      // have access to the Metro server.
      debug('Skipping TypeScript check because Metro is not running (headless).');
      return;
    }

    const off = waitForMetroToObserveTypeScriptFile(
      this.projectRoot,
      { server: this.instance!.server, metro: this.metro },
      async () => {
        // Run once, this prevents the TypeScript project prerequisite from running on every file change.
        off();
        const { TypeScriptProjectPrerequisite } = await import(
          '../../doctor/typescript/TypeScriptProjectPrerequisite'
        );

        try {
          const req = new TypeScriptProjectPrerequisite(this.projectRoot);
          await req.bootstrapAsync();
        } catch (error: any) {
          // Ensure the process doesn't fail if the TypeScript check fails.
          // This could happen during the install.
          Log.log();
          Log.error(
            chalk.red`Failed to automatically setup TypeScript for your project. Try restarting the dev server to fix.`
          );
          Log.exception(error);
        }
      }
    );
  }

  protected getConfigModuleIds(): string[] {
    return ['./metro.config.js', './metro.config.json', './rn-cli.config.js'];
  }
}

function getErrorResult(error: Error) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
    <title>Error</title>
  </head>
  <body>
    <h1>Failed to render static app</h1>
    <pre>${error.stack}</pre>
  </body>
  </html>
  `;
}

export function getDeepLinkHandler(projectRoot: string): DeepLinkHandler {
  return async ({ runtime }) => {
    if (runtime === 'expo') return;
    const { exp } = getConfig(projectRoot);
    await logEventAsync('dev client start command', {
      status: 'started',
      ...getDevClientProperties(projectRoot, exp),
    });
  };
}
