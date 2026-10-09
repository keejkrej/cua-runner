export type Log = (event: string, fields: Record<string, string | number | boolean>) => void

export const consoleLog: Log = (event, fields) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}

export const silentLog: Log = () => {}
