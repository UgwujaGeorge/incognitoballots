import { Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import Home from './pages/Home'
import CreateProposal from './pages/CreateProposal'
import BrowseProposals from './pages/BrowseProposals'
import Vote from './pages/Vote'
import Results from './pages/Results'

export default function App() {
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/create" element={<CreateProposal />} />
        <Route path="/browse" element={<BrowseProposals />} />
        <Route path="/vote/:proposal" element={<Vote />} />
        <Route path="/results/:proposal" element={<Results />} />
      </Routes>
    </>
  )
}
