import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import App from './App'
import './index.css'
import '@solana/wallet-adapter-react-ui/styles.css'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: any) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', background: '#1a0f0a', color: '#e07070', minHeight: '100vh' }}>
          <h2>App Error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 16 }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, color: '#c9a882', fontSize: 12 }}>{this.state.error.stack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

const wallets = [new PhantomWalletAdapter()]
const endpoint = 'https://api.devnet.solana.com'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </ErrorBoundary>
)
