#!/usr/bin/env node

const { homedir } = require('os')
const path = require('path')
const { formatWithOptions } = require('util')
const produce = require('immer').default
const nanobus = require('nanobus')
const nanostate = require('nanostate')
const delay = require('delay')
const { mineshaftStart, mineshaftStop } = require('@jimpick/filecoin-pickaxe-mineshaft')
const worker = require('./worker')

const bus = nanobus()

const statesAndTransitions = {
  ack: { next: 'queuing' },
  queuing: { next: 'queued' },
  queued: { next: 'proposing' },
  proposing: {
    success: 'dealSuccess',
    fail: 'dealFailed'
  },
  dealFailed: {},
  dealSuccess: {}
}

const active = new Set()

bus.on('newState', ({ dealRequests }, context) => {
  for (const dealRequestId in dealRequests) {
    const dealRequest = dealRequests[dealRequestId]
    if (!dealRequest.agentState && !active.has(dealRequestId)) {
      active.add(dealRequestId)
      bus.emit('newDealRequest', dealRequestId, dealRequest, context)
    }
  }
})

bus.on('newDealRequest', async (dealRequestId, dealRequest, context) => {
  console.log('New deal request', dealRequestId, dealRequest)
  const machine = nanostate('ack', statesAndTransitions)
  const jobBus = nanobus() 
  while (Object.keys(statesAndTransitions[machine.state]).length > 0) {
    console.log('Entered:', machine.state, dealRequestId)
    updateDealRequestState()
    if (machine.state === 'queuing') {
      await worker.queueProposeDeal(
        jobBus,
        dealRequestId,
        dealRequest.dealRequest
      )
      machine.emit('next')
    } else if (machine.state === 'queued') {
      await waitFor('started')
      machine.emit('next')
    } else if (machine.state === 'proposing') {
      const [ result, data ] = await waitFor(['success', 'fail'])
      if (result === 'fail') {
        context.dealRequests.applySub(
          dealRequestId, 'ormap', 'applySub',
          `errorMsg`, 'mvreg', 'write',
          JSON.stringify(data)
        )
      }
      if (result === 'success') {
        context.dealRequests.applySub(
          dealRequestId, 'ormap', 'applySub',
          `deal`, 'mvreg', 'write',
          JSON.stringify(data)
        )
      }
      machine.emit(result)
    } else {
      await delay(1000)
      machine.emit('next')
    }
  }
  console.log('Done', dealRequestId)
  updateDealRequestState()

  function waitFor (message) {
    if (typeof message === 'object') { // Array
      const messages = message
      const promises = messages.map(message => waitFor(message))
      return Promise.race(promises)
    } else {
      return new Promise(resolve => {
        return jobBus.once(message, data => resolve([ message, data ]))
      })
    }
  }

  function updateDealRequestState () {
    const record = {
      state: machine.state
    }
    context.dealRequests.applySub(
      dealRequestId, 'ormap', 'applySub',
      `agentState`, 'mvreg', 'write',
      JSON.stringify(record)
    )
  }
})

async function run () {
  const configFile = process.argv[2] || path.resolve(
    homedir(),
    '.filecoin-pickaxe',
    'pickaxe-config'
  )
  const mineshaft = await mineshaftStart('filecoin-pickaxe-agent', configFile)
  const bundleImports = await mineshaft.bundleImports()
  const dealRequests = await mineshaft.dealRequests()
  const minerDealRequests = await mineshaft.minerDealRequests()

  printCollab()
  printBundleImports()
  printDealRequests()
  mineshaft.collaboration.shared.on('state changed', printCollab)
  bundleImports.shared.on('state changed', printBundleImports)
  dealRequests.shared.on('state changed', printDealRequests)
  minerDealRequests.shared.on('state changed', printMinerDealRequests)

  const context = {
    mineshaft,
    bundles: mineshaft.collaboration.shared,
    bundleImports: bundleImports.shared,
    dealRequests: dealRequests.shared,
    minerDealRequests: minerDealRequests.shared
  }

  function printCollab () {
    // console.log('collaboration', mineshaft.collaboration.shared.value())
  }

  function printBundleImports () {
    // console.log('bundleImports', bundleImports.shared.value())
  }

  function printDealRequests () {
    // console.log('dealRequests', dealRequests.shared.value())
  }

  function printMinerDealRequests () {
    // console.log('minerDealRequests', minerDealRequests.shared.value())
  }

  let state = {}
  updateState()
  // mineshaft.collaboration.shared.on('state changed', updateState)
  // bundleImports.shared.on('state changed', updateState)
  dealRequests.shared.on('state changed', updateState)

  function updateState () {
    const newState = produce(state, draft => {
      // bundles
      /*
      draft.bundles = mineshaft.collaboration.shared.value()
        .map(string => JSON.parse(string))
      */

      // bundleImports
      /*
      const rawBundleImports = bundleImports.shared.value()
      const formattedBundleImports = {}
      Object.keys(rawBundleImports).forEach(bundleName => {
        const rawImports = rawBundleImports[bundleName]
        const imports = []
        Object.keys(rawImports).map(timestamp => Number(timestamp)).sort()
          .forEach(timestamp => {
            imports.push({
              timestamp,
              ...JSON.parse([...rawImports[timestamp]][0])
            })
          })
        formattedBundleImports[bundleName] = imports
      })
      draft.bundleImports = formattedBundleImports
      */

      // dealRequests
      const rawDealRequests = dealRequests.shared.value()
      const formattedDealRequests = {}
      for (const dealRequestId in rawDealRequests) {
        const rawDealRequest = rawDealRequests[dealRequestId]
        const formatted = {}
        for (const propKey in rawDealRequest) {
          const propValue = rawDealRequest[propKey]
          formatted[propKey] = JSON.parse([...propValue][0])
        }
        formattedDealRequests[dealRequestId] = formatted
      }
      draft.dealRequests = formattedDealRequests
    })
    state = newState
    /*
    console.log(
      'New state',
      formatWithOptions({ colors: true, depth: Infinity }, '%O', state)
    )
    */
    bus.emit('newState', state, context)
  }
}

run()

process.on('SIGINT', async () => {
  console.log('Exiting...')
  await mineshaftStop()
  console.log('Done.')
})
