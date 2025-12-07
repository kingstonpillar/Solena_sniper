# ensure dry-run
export DRY_RUN=true

# run a one-liner that imports swapexecutor and calls executeSwap (SOL -> SOL test)
node -e "import('./swapexecutor.js').then(m => m.executeSwap('So11111111111111111111111111111111111111112','So11111111111111111111111111111111111111112')).then(r=>console.log('RESULT:',JSON.stringify(r)).catch(console.error)).catch(console.error)"