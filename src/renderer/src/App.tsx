import { useEffect, useState } from 'react'

function App(): React.JSX.Element {
  const [reply, setReply] = useState('...')

  useEffect(() => {
    window.hml.ping().then(setReply)
  }, [])

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">HML</h1>
      <p>{reply}</p>
    </div>
  )
}

export default App
