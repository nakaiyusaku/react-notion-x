import PQueue from 'p-queue'
import type { Client } from '@notionhq/client'
import { parsePageId } from 'notion-utils'
import * as notion from 'notion-types'

import * as types from './types'

import { convertPage } from './convert-page'
import { convertBlock } from './convert-block'
import { convertRichTextItem } from './convert-rich-text'

export class NotionCompatAPI {
  client: Client

  constructor(client: Client) {
    this.client = client
  }

  public async getPage(rawPageId: string): Promise<notion.ExtendedRecordMap> {
    const pageId = parsePageId(rawPageId)

    try {
      const [page, block, children] = await Promise.all([
        this.client.pages.retrieve({ page_id: pageId }),
        this.client.blocks.retrieve({ block_id: pageId }),
        this.getAllBlockChildren(pageId)
      ])

      //
      const dbBlocks = children.filter((e: any) => e.type === 'child_database')
      const dbList = await Promise.all(
        dbBlocks.map(
          async (e) =>
            await this.client.databases.retrieve({ database_id: e.id })
        )
      )
      const dbMap = Object.fromEntries(dbList.map((e) => [e.id, e]))
      // console.log("---dbMap---")
      // console.log(JSON.stringify(dbMap, null, 2))

      const { blockMap, blockChildrenMap, pageMap, parentMap } =
        await this.resolvePage(pageId)

      // console.log("---page");
      //console.log(JSON.stringify(page));
      // console.log("---block");
      // console.log(JSON.stringify(block));
      //console.log("---children");
      // console.log(JSON.stringify(children));
      // console.log("---blockMap");
      // console.log(JSON.stringify(blockMap));
      // console.log("---blockChildrenMap");
      // console.log(JSON.stringify(blockChildrenMap));
      // console.log("---");

      const recordMap = convertPage({
        pageId,
        blockMap,
        blockChildrenMap,
        pageMap,
        parentMap,
        dbMap
      })

      // console.log("---make collections---");
      const collections = Object.fromEntries(
        dbList
          .map((e: any): any => {
            // console.log(JSON.stringify(e, null, "  "));

            // console.log(e.properties);

            const props = Object.keys(e.properties)
              .map((key) => {
                return {
                  key: key,
                  ...e.properties[key]
                }
              })
              .reverse()
            const format = {
              collection_page_properties: props
                .filter((prop) => prop.id !== 'title')
                .map((prop) => {
                  // console.log(prop);
                  return {
                    visible: true,
                    property: prop.id
                  }
                })
            }
            // console.log(format);

            const schema = Object.fromEntries(
              props.map((prop) => {
                let type = prop.type
                switch (prop.type) {
                  case 'rich_text':
                    type = 'text'
                    break
                  default:
                    break
                }
                const propDetail: any = {
                  name: prop.name,
                  type: type
                }
                // console.log(JSON.stringify(prop, null, "  "));
                if (prop.multi_select?.options) {
                  propDetail.options =
                    prop.multi_select?.options.map((option) => {
                      return {
                        id: option.id,
                        color: option.color,
                        value: option.name
                      }
                    }) ?? []
                }
                return [prop.id, propDetail]
              })
            )

            return {
              role: 'reader',
              value: {
                id: e.id,
                version: 1, // dummy
                name: [[e.title[0].plain_text]] ?? null, // TODO: 無題の時nullでいいか確認
                schema: schema,
                icon: e.icon,
                parent_id: e.id,
                parent_table: 'block',
                alive: !e.archived,
                migrated: true, // TODO: 何かわからない
                format: format
              }
            }
          })
          .map((e) => [e.value.id, e])
      )
      recordMap.collection = collections

      const collection_view = Object.fromEntries(
        dbList
          .map((e: any): any => {
            const props = Object.keys(e.properties)
              .map((key) => {
                return {
                  key: key,
                  ...e.properties[key]
                }
              })
              .reverse()
            const tableProps = props.map((prop) => {
              return {
                visible: true,
                property: prop.id
              }
            })
            // console.log(JSON.stringify(tableProps, null, "  "));

            return {
              role: 'reader',
              value: {
                id: e.id,
                version: 1, // dummy
                type: 'table',

                format: {
                  table_properties: tableProps,
                  collection_pointer: {
                    id: e.id,
                    table: 'collection'
                    // spaceId: e.spaceId,
                  }
                },
                parent_id: e.parent?.page_id,
                parent_table: 'block',
                alive: !e.archived,
                page_sort: [
                  // TODO
                ]
                // spaceId: e.spaceId,
              }
            }
          })
          .map((e) => [e.value.id, e])
      )
      recordMap.collection_view = collection_view

      const queryResults = await Promise.all(
        dbList.map(async (db) => {
          const queryResult = await this.client.databases.query({
            database_id: db.id
            // sorts: [{
            //   timestamp: "created_time",
            //   direction: "ascending"
            // }]
          })
          // console.log(JSON.stringify(queryResult.results.map(e=>e), null, "  "));

          if (collection_view[db.id]) {
            collection_view[db.id].value.page_sort = queryResult.results.map(
              (result) => result.id
            )
          }

          blockChildrenMap[db.id] = queryResult.results.map(
            (result) => result.id
          )

          // blockMapに詰める
          await Promise.all(
            queryResult.results.map(async (item: any) => {
              const page = (await this.client.pages.retrieve({
                page_id: item.id
              })) as any
              const block = await this.client.blocks.retrieve({
                block_id: item.id
              })

              if (page.parent) {
                const parent = page.parent
                // console.log("---parent---");
                // console.log(parent);
                parentMap[block.id] = parent.database_id
              }

              // console.log("---compatBlock---");
              // console.log(block.id);
              // console.log(JSON.stringify(block, null, "  "));
              const compatBlock = convertBlock({
                block: block,
                children: blockChildrenMap[block.id],
                pageMap: pageMap,
                blockMap: blockMap,
                parentMap: parentMap,
                dbMap: dbMap
              })

              const blockProps = await Promise.all(
                Object.keys(page.properties).map(async (propKey) => {
                  const prop = page.properties[propKey]
                  const response = await this.client.pages.properties.retrieve({
                    page_id: item.id,
                    property_id: prop.id
                  })
                  return response
                })
              )

              // if (item.id === "05282a0b-379c-4ca5-8dc9-e8ec85aa15b4"){
              //   console.log(JSON.stringify(blockProps, null, "  "));
              // }
              blockProps.map((prop) => {
                if (prop.object === 'list') {
                  prop.results.map((propResult) => {
                    switch (propResult.type) {
                      case 'rich_text':
                        compatBlock.properties = {
                          ...compatBlock.properties,
                          [propResult.id]: [
                            convertRichTextItem(propResult.rich_text)
                          ]
                        }
                        break
                      case 'title':
                        // 既に入っているはずなので何もしない
                        break
                      default:
                        console.log('未対応Prop')
                        console.log(JSON.stringify(propResult, null, 2))
                        break
                    }
                  })
                } else if (prop.object === 'property_item') {
                  switch (prop.type) {
                    case 'multi_select':
                      compatBlock.properties = {
                        ...compatBlock.properties,
                        [prop.id]: [
                          [prop.multi_select.map((e) => e.name).join(',')]
                        ]
                      }
                      break
                    default:
                      console.log('未対応Prop')
                      console.log(JSON.stringify(prop, null, 2))
                      break
                  }
                }
              })
              // console.log(JSON.stringify(page, null, "  "));

              recordMap.block = {
                ...recordMap.block,
                [item.id]: {
                  role: 'reader',
                  value: compatBlock
                }
              }

              // console.log("------");
              // console.log(JSON.stringify(compatBlock, null, "  "));

              // const itemId: string = item.id;
              // const itemPage = await this.resolvePage(itemId);

              // const recordMap2 = convertPage({
              //   pageId: itemId,
              //   blockMap: itemPage.blockMap,
              //   blockChildrenMap: itemPage.blockChildrenMap,
              //   pageMap: itemPage.pageMap,
              //   parentMap: itemPage.parentMap,
              //   dbMap
              // });

              // recordMap.block = {
              //   ...recordMap.block,
              //   ...recordMap2.block
              // };
            })
          )

          return {
            collectionId: db.id,
            collection_group_results: {
              type: 'results',
              blockIds: queryResult.results.map((e) => e.id),
              hasMore: queryResult.has_more
            }
          }
        })
      )
      const collection_query = Object.fromEntries(
        queryResults.map((e) => {
          return [
            e.collectionId,
            {
              [e.collectionId]: {
                collection_group_results: e.collection_group_results
              }
            }
          ]
        })
      ) as any
      recordMap.collection_query = collection_query

      // console.log('---compatBlock---')
      // console.log(JSON.stringify(recordMap.block["5dd04022-936b-44cf-893b-42ae56864a77"], null, '  '))
      // console.log('---compatBlock---')
      // console.log(JSON.stringify(recordMap.block["0981fcf1-8313-4ee5-b611-a69deca88ce4"], null, '  '))
      // console.log('---compatBlock---')
      // console.log(JSON.stringify(recordMap.block["bf952324-cd9a-458a-940b-25d76909936c"], null, '  '))
      // console.log('---compatBlock---')
      // console.log(JSON.stringify(recordMap.block["19e101ea-c8d1-4159-a7ef-fdc94275ffb7"], null, '  '))
      // console.log('---compatBlock---')
      // console.log(JSON.stringify(recordMap.block["356535b3-b1c0-4876-885d-b8370c001f84"], null, '  '))

      // console.log('---compatBlock---')
      // console.log(JSON.stringify(recordMap.block["05282a0b-379c-4ca5-8dc9-e8ec85aa15b4"], null, '  '))

      // console.log('---collections---')
      // console.log(JSON.stringify(collections, null, '  '))
      // console.log('---collection_view---')
      // console.log(JSON.stringify(collection_view, null, '  '))
      // console.log('---collection_query---')
      // console.log(JSON.stringify(collection_query, null, '  '))
      // console.log('---end---')
      ;(recordMap as any).raw = {
        page,
        block,
        children
      }

      return recordMap
    } catch {
      // const db = await this.client.databases.retrieve({ database_id: pageId });
      // //console.log(db);

      // const { blockMap, blockChildrenMap, pageMap, parentMap } =
      //   await this.resolvePage(pageId)
      // //console.log( blockMap, blockChildrenMap, pageMap, parentMap );

      // const recordMap = convertPage({
      //   pageId,
      //   blockMap,
      //   blockChildrenMap,
      //   pageMap,
      //   parentMap,
      //   dbMap
      // })

      // return recordMap
      return null
    }
  }

  async resolvePage(
    rootBlockId: string,
    {
      concurrency = 4
    }: {
      concurrency?: number
    } = {}
  ) {
    const blockMap: types.BlockMap = {}
    const pageMap: types.PageMap = {}
    const parentMap: types.ParentMap = {}
    const blockChildrenMap: types.BlockChildrenMap = {}
    const pendingBlockIds = new Set<string>()
    const queue = new PQueue({ concurrency })

    const processBlock = async (
      blockId: string,
      { shallow = false }: { shallow?: boolean } = {}
    ) => {
      if (!blockId || pendingBlockIds.has(blockId)) {
        return
      }

      pendingBlockIds.add(blockId)
      queue.add(async () => {
        try {
          let partialBlock = blockMap[blockId]
          if (!partialBlock) {
            partialBlock = await this.client.blocks.retrieve({
              block_id: blockId
            })
            blockMap[blockId] = partialBlock
          }

          const block = partialBlock as types.Block
          if (block.type === 'child_page') {
            if (!pageMap[blockId]) {
              const partialPage = await this.client.pages.retrieve({
                page_id: blockId
              })

              pageMap[blockId] = partialPage

              const page = partialPage as types.Page
              switch (page.parent?.type) {
                case 'page_id':
                  processBlock(page.parent.page_id, {
                    shallow: true
                  })
                  if (!parentMap[blockId]) {
                    parentMap[blockId] = page.parent.page_id
                  }
                  break

                case 'database_id':
                  processBlock(page.parent.database_id, {
                    shallow: true
                  })
                  if (!parentMap[blockId]) {
                    parentMap[blockId] = page.parent.database_id
                  }
                  break
              }
            }

            if (blockId !== rootBlockId) {
              // don't fetch children or recurse on subpages
              return
            }
          }

          if (shallow) {
            return
          }

          const children = await this.getAllBlockChildren(blockId)
          blockChildrenMap[blockId] = children.map((child) => child.id)

          for (const child of children) {
            const childBlock = child as types.Block
            const mappedChildBlock = blockMap[child.id] as types.Block
            if (
              !mappedChildBlock ||
              (!mappedChildBlock.type && childBlock.type)
            ) {
              blockMap[child.id] = childBlock
              parentMap[child.id] = blockId

              const details = childBlock[childBlock.type]
              if (details?.rich_text) {
                const richTextMentions = details.rich_text.filter(
                  (richTextItem) => richTextItem.type === 'mention'
                )

                for (const richTextMention of richTextMentions) {
                  switch (richTextMention.mention?.type) {
                    case 'page': {
                      const pageId = richTextMention.mention.page.id
                      processBlock(pageId, { shallow: true })
                      break
                    }

                    case 'database': {
                      const databaseId = richTextMention.mention.database.id
                      processBlock(databaseId, { shallow: true })
                      break
                    }
                  }
                }
              }

              if (childBlock.type === 'link_to_page') {
                switch (childBlock.link_to_page?.type) {
                  case 'page_id':
                    processBlock(childBlock.link_to_page.page_id, {
                      shallow: true
                    })
                    break

                  case 'database_id':
                    processBlock(childBlock.link_to_page.database_id, {
                      shallow: true
                    })
                    break
                }
              }

              if (
                childBlock.has_children &&
                childBlock.type !== 'child_database'
              ) {
                processBlock(childBlock.id)
              }
            }
          }
        } catch (err) {
          console.warn('failed resolving block', blockId, err.message)
        } finally {
          pendingBlockIds.delete(blockId)
        }
      })
    }

    await processBlock(rootBlockId)
    await queue.onIdle()

    return {
      blockMap,
      blockChildrenMap,
      pageMap,
      parentMap
    }
  }

  async getAllBlockChildren(blockId: string) {
    let blocks: types.BlockChildren = []
    let cursor: string

    do {
      console.log('blocks.children.list', { blockId, cursor })
      const res = await this.client.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor
      })

      blocks = blocks.concat(res.results)
      cursor = res.next_cursor
    } while (cursor)

    return blocks
  }
}
