/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path'
import * as vscode from 'vscode'
import { ExtContext } from '../shared/extensions'
import { ExtensionUtilities, isCloud9 } from '../shared/extensionUtilities'
import { Commands, Events, OptionsToProtocol, registerWebviewServer, WebviewCompileOptions } from './server'

interface WebviewParams {
    id: string
    name: string
    webviewJs: string
    persistWithoutFocus?: boolean
    cssFiles?: string[]
    libFiles?: string[]
}

/**
 * Webviews are 'compiled'
 */
export interface VueWebview<C extends Commands, E extends Events, D, S> {
    show(data?: D): Promise<S | undefined>
    readonly emitters: E
    readonly protocol: OptionsToProtocol<WebviewCompileOptions<C, E, D, S>>
}

/**
 * Generates an anonymous class whose instances have the interface {@link VueWebview}.
 *
 * You can give this class a name by extending off of it:
 * ```ts
 * export class MyWebview extends compileVueWebview(...) {}
 * const view = new MyWebview()
 * view.show()
 * ```
 *
 * @param params Required parameters are defined by {@link WebviewParams}, optional parameters are defined by {@link WebviewCompileOptions}
 * @returns
 */
export function compileVueWebview<C extends Commands, E extends Events, D, S>(
    params: WebviewParams & WebviewCompileOptions<C, E, D, S>
): { new (context: ExtContext): VueWebview<C, E, D, S> } {
    return class implements VueWebview<C, E, D, S> {
        public readonly protocol = {
            submit: () => {},
            init: () => ({} as D),
            ...params.commands,
            ...params.events,
        } as any
        public readonly emitters: E
        public async show(data?: D): Promise<S | undefined> {
            await params.validateData?.(data)
            const panel = createVueWebview({ ...params, context: this.context })
            return new Promise<S | undefined>((resolve, reject) => {
                const onDispose = panel.onDidDispose(() => resolve(undefined))

                if (params.commands) {
                    const submit = async (response: S) => {
                        const validate = params.validateSubmit?.(response)
                        if (validate && (await validate)) {
                            onDispose.dispose()
                            panel.dispose()
                            resolve(response)
                        }
                    }
                    const init = async () => data
                    const modifiedWebview = Object.assign(panel.webview, {
                        dispose: () => panel.dispose(),
                        context: this.context,
                        emitters: this.emitters,
                        arguments: data,
                    })
                    registerWebviewServer(modifiedWebview, { init, submit, ...params.commands, ...this.emitters })
                }
            })
        }
        constructor(private readonly context: ExtContext) {
            const copyEmitters = {} as E
            Object.keys(params.events ?? {}).forEach(k => {
                Object.assign(copyEmitters, { [k]: new vscode.EventEmitter() })
            })
            this.emitters = copyEmitters
        }
    } as any
}

export type ProtocolFromWeview<W> = W extends VueWebview<any, any, any, any> ? W['protocol'] : never

function createVueWebview(params: WebviewParams & { context: ExtContext }): vscode.WebviewPanel {
    const context = params.context.extensionContext
    const libsPath: string = path.join(context.extensionPath, 'media', 'libs')
    const jsPath: string = path.join(context.extensionPath, 'media', 'js')
    const cssPath: string = path.join(context.extensionPath, 'media', 'css')
    const webviewPath: string = path.join(context.extensionPath, 'dist')
    const resourcesPath: string = path.join(context.extensionPath, 'resources')

    const panel = vscode.window.createWebviewPanel(
        params.id,
        params.name,
        // Cloud9 opens the webview in the bottom pane unless a second pane already exists on the main level.
        isCloud9() ? vscode.ViewColumn.Two : vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            enableCommandUris: true,
            localResourceRoots: [
                vscode.Uri.file(libsPath),
                vscode.Uri.file(jsPath),
                vscode.Uri.file(cssPath),
                vscode.Uri.file(webviewPath),
                vscode.Uri.file(resourcesPath),
            ],
            // HACK: Cloud9 does not have get/setState support. Remove when it does.
            retainContextWhenHidden: isCloud9() ? true : params.persistWithoutFocus,
        }
    )

    const loadLibs = ExtensionUtilities.getFilesAsVsCodeResources(
        libsPath,
        ['vue.min.js', ...(params.libFiles ?? [])],
        panel.webview
    ).concat(ExtensionUtilities.getFilesAsVsCodeResources(jsPath, ['loadVsCodeApi.js'], panel.webview))

    const loadCss = ExtensionUtilities.getFilesAsVsCodeResources(cssPath, [...(params.cssFiles ?? [])], panel.webview)

    let scripts: string = ''
    let stylesheets: string = ''

    loadLibs.forEach(element => {
        scripts = scripts.concat(`<script src="${element}"></script>\n\n`)
    })

    loadCss.forEach(element => {
        stylesheets = stylesheets.concat(`<link rel="stylesheet" href="${element}">\n\n`)
    })

    const mainScript = panel.webview.asWebviewUri(vscode.Uri.file(path.join(webviewPath, params.webviewJs)))

    panel.title = params.name
    panel.webview.html = resolveWebviewHtml({
        scripts,
        stylesheets,
        main: mainScript,
        webviewJs: params.webviewJs,
        cspSource: panel.webview.cspSource,
    })

    return panel
}

/**
 * Resolves the webview HTML based off whether we're running from a development server or bundled extension.
 */
function resolveWebviewHtml(params: {
    scripts: string
    stylesheets: string
    cspSource: string
    webviewJs: string
    main: vscode.Uri
}): string {
    const resolvedParams = { ...params, connectSource: 'none' }
    const LOCAL_SERVER = process.env.WEBPACK_DEVELOPER_SERVER

    if (LOCAL_SERVER) {
        const local = vscode.Uri.parse(LOCAL_SERVER)
        resolvedParams.cspSource = `${params.cspSource} ${local.toString()}`
        resolvedParams.main = local.with({ path: `/${params.webviewJs}` })
        resolvedParams.connectSource = `'self' ws:`
    }

    return `<html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        
        <meta
            http-equiv="Content-Security-Policy"
            content=
                "default-src 'none';
                connect-src ${resolvedParams.connectSource};
                img-src ${resolvedParams.cspSource} https:;
                script-src ${resolvedParams.cspSource};
                style-src ${resolvedParams.cspSource} 'unsafe-inline';
                font-src 'self' data:;"
        >
    </head>
    <body>
        <div id="vue-app"></div>
        <!-- Dependencies -->
        ${resolvedParams.scripts}
        ${resolvedParams.stylesheets}
        <!-- Main -->
        <script src="${resolvedParams.main}"></script>
    </body>
</html>`
}
