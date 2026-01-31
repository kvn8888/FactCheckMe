-- Create tables for fact-checking app

-- Create enum for verdict types
CREATE TYPE public.verdict_type AS ENUM ('true', 'false', 'partial', 'unverifiable');

-- Sessions table for monitoring sessions
CREATE TABLE public.fact_check_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ended_at TIMESTAMP WITH TIME ZONE,
  claims_checked INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Fact check results table
CREATE TABLE public.fact_check_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID REFERENCES public.fact_check_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  claim TEXT NOT NULL,
  verdict public.verdict_type NOT NULL,
  confidence INTEGER CHECK (confidence >= 0 AND confidence <= 100),
  explanation TEXT,
  sources JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.fact_check_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_check_results ENABLE ROW LEVEL SECURITY;

-- RLS Policies for sessions - allow unauthenticated users for demo
CREATE POLICY "Anyone can view sessions" 
  ON public.fact_check_sessions 
  FOR SELECT 
  USING (true);

CREATE POLICY "Anyone can create sessions" 
  ON public.fact_check_sessions 
  FOR INSERT 
  WITH CHECK (true);

CREATE POLICY "Anyone can update sessions" 
  ON public.fact_check_sessions 
  FOR UPDATE 
  USING (true);

-- RLS Policies for results - allow unauthenticated users for demo
CREATE POLICY "Anyone can view results" 
  ON public.fact_check_results 
  FOR SELECT 
  USING (true);

CREATE POLICY "Anyone can create results" 
  ON public.fact_check_results 
  FOR INSERT 
  WITH CHECK (true);

-- Enable realtime for results
ALTER PUBLICATION supabase_realtime ADD TABLE public.fact_check_results;