import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL não configurada — o backend vai falhar em qualquer query.')
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c search_path=assistant_ia',
})
