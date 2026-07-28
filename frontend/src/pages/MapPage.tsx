import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listFires, type Fire } from '../api'
import { FireMap } from '../components/FireMap'

export function MapPage() {
  const [fires, setFires] = useState<Fire[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    listFires()
      .then(setFires)
      .catch(() => setFires([]))
  }, [])

  return (
    <div className="map-page">
      <FireMap fires={fires} onSelectFire={(id) => navigate(`/fires/${id}`)} />
    </div>
  )
}
