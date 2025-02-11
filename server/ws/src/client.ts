//
// Copyright © 2022 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import core, {
  AccountRole,
  TxFactory,
  TxProcessor,
  type Account,
  type Branding,
  type Class,
  type Doc,
  type DocumentQuery,
  type FindOptions,
  type FindResult,
  type MeasureContext,
  type Ref,
  type SearchOptions,
  type SearchQuery,
  type Timestamp,
  type Tx,
  type TxCUD,
  type WorkspaceIdWithUrl
} from '@hcengineering/core'
import { SessionDataImpl, createBroadcastEvent, type Pipeline } from '@hcengineering/server-core'
import { type Token } from '@hcengineering/server-token'
import {
  type ClientSessionCtx,
  type ConnectionSocket,
  type Session,
  type SessionRequest,
  type StatisticsElement
} from './types'
import { handleSend } from './utils'
/**
 * @public
 */
export class ClientSession implements Session {
  createTime = Date.now()
  requests = new Map<string, SessionRequest>()
  binaryMode: boolean = false
  useCompression: boolean = true
  sessionId = ''
  lastRequest = Date.now()

  total: StatisticsElement = { find: 0, tx: 0 }
  current: StatisticsElement = { find: 0, tx: 0 }
  mins5: StatisticsElement = { find: 0, tx: 0 }
  measures: { id: string, message: string, time: 0 }[] = []

  constructor (
    protected readonly token: Token,
    protected readonly _pipeline: Pipeline,
    readonly workspaceId: WorkspaceIdWithUrl,
    readonly branding: Branding | null
  ) {}

  getUser (): string {
    return this.token.email
  }

  isUpgradeClient (): boolean {
    return this.token.extra?.model === 'upgrade'
  }

  getMode (): string {
    return this.token.extra?.mode ?? 'normal'
  }

  pipeline (): Pipeline {
    return this._pipeline
  }

  async ping (ctx: ClientSessionCtx): Promise<void> {
    // console.log('ping')
    this.lastRequest = Date.now()
    await ctx.sendResponse('pong!')
  }

  async loadModel (ctx: ClientSessionCtx, lastModelTx: Timestamp, hash?: string): Promise<void> {
    this.includeSessionContext(ctx.ctx)
    const result = await ctx.ctx.with('load-model', {}, () => this._pipeline.loadModel(ctx.ctx, lastModelTx, hash))
    await ctx.sendResponse(result)
  }

  async getAccount (ctx: ClientSessionCtx): Promise<void> {
    const account = this._pipeline.context.modelDb.getAccountByEmail(this.token.email)
    if (account === undefined && this.token.extra?.admin === 'true') {
      const systemAccount = this._pipeline.context.modelDb.findObject(this.token.email as Ref<Account>)
      if (systemAccount === undefined) {
        // Generate account for admin user
        const factory = new TxFactory(core.account.System)
        const email = `system:${this.token.email}`
        const createTx = factory.createTxCreateDoc(
          core.class.Account,
          core.space.Model,
          {
            role: AccountRole.Owner,
            email
          },
          this.token.email as Ref<Account>
        )
        this.includeSessionContext(ctx.ctx)
        await this._pipeline.tx(ctx.ctx, [createTx])
        const acc = TxProcessor.createDoc2Doc(createTx)
        await ctx.sendResponse(acc)
        return
      } else {
        await ctx.sendResponse(systemAccount)
        return
      }
    }
    await ctx.sendResponse(account)
  }

  includeSessionContext (ctx: MeasureContext): void {
    const contextData = new SessionDataImpl(
      this.token.email,
      this.sessionId,
      this.token.extra?.admin === 'true',
      {
        txes: [],
        targets: {}
      },
      this.workspaceId,
      this.branding,
      false,
      new Map(),
      new Map(),
      this._pipeline.context.modelDb
    )
    ctx.contextData = contextData
  }

  findAllRaw<T extends Doc>(
    ctx: MeasureContext,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    this.lastRequest = Date.now()
    this.total.find++
    this.current.find++
    this.includeSessionContext(ctx)
    return this._pipeline.findAll(ctx, _class, query, options)
  }

  async findAll<T extends Doc>(
    ctx: ClientSessionCtx,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<void> {
    await ctx.sendResponse(await this.findAllRaw(ctx.ctx, _class, query, options))
  }

  async searchFulltext (ctx: ClientSessionCtx, query: SearchQuery, options: SearchOptions): Promise<void> {
    this.lastRequest = Date.now()
    this.includeSessionContext(ctx.ctx)
    await ctx.sendResponse(await this._pipeline.searchFulltext(ctx.ctx, query, options))
  }

  async tx (ctx: ClientSessionCtx, tx: Tx): Promise<void> {
    this.lastRequest = Date.now()
    this.total.tx++
    this.current.tx++
    this.includeSessionContext(ctx.ctx)

    const result = await this._pipeline.tx(ctx.ctx, [tx])

    // Send result immideately
    await ctx.sendResponse(result)

    // We need to broadcast all collected transactions
    await this._pipeline.handleBroadcast(ctx.ctx)
  }

  broadcast (ctx: MeasureContext, socket: ConnectionSocket, tx: Tx[]): void {
    if (this.tx.length > 10000) {
      const classes = new Set<Ref<Class<Doc>>>()
      for (const dtx of tx) {
        if (TxProcessor.isExtendsCUD(dtx._class)) {
          classes.add((dtx as TxCUD<Doc>).objectClass)
        }
        const etx = TxProcessor.extractTx(dtx)
        if (TxProcessor.isExtendsCUD(etx._class)) {
          classes.add((etx as TxCUD<Doc>).objectClass)
        }
      }
      const bevent = createBroadcastEvent(Array.from(classes))
      socket.send(
        ctx,
        {
          result: [bevent]
        },
        this.binaryMode,
        this.useCompression
      )
    } else {
      void handleSend(ctx, socket, { result: tx }, 1024 * 1024, this.binaryMode, this.useCompression)
    }
  }
}
