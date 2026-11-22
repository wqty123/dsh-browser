process.send?.({ pid: process.pid, executable: process.execPath, argv: process.argv })
setInterval(() => {}, 1000)
